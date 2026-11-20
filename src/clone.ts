import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ControllerConfig, devicesOf, getControllers } from './config';
import { ControllerNode, ControllerTreeProvider } from './controllerTree';
import * as ftp from './ftp';
import { ReportEntry, buildReport } from './cloneReport';
import { isReadOnlyReport } from './ioKarel';
import { Wizard, button, cancelButton, esc, list, message, page } from './welderUi';
import {
	CloneChange,
	CloneManifest,
	MANIFEST_NAME,
	SyncCheck,
	SyncState,
	classifyChange,
	computeChanges,
	contentHash,
	deviceFolder,
	findCloneRoot,
	matchesTypes,
	readManifest,
	sha1File,
	writeManifest
} from './cloneCore';

export interface CloneDeps {
	withProgress<T>(title: string, fn: (progress: vscode.Progress<{ message?: string }>) => Promise<T>): Thenable<T>;
	rememberOrigin(localPath: string, origin: { controller: string; remotePath: string }): void;
	showDiff(controller: ControllerConfig, remotePath: string, localPath: string, column?: vscode.ViewColumn): Promise<void>;
	pickController(): Promise<ControllerConfig | undefined>;
	resolveDownloadDir(): Promise<string | undefined>;
	/** Nach Uploads: Programmliste des Controllers neu laden. */
	programsChanged(controllerName: string): void;
	/** Anzahl der Syntaxfehler einer Datei (0 für Nicht-LS-Dateien). */
	countErrors(file: string): Promise<number>;
}

const MAX_DEPTH = 3;

export function registerCloneCommands(
	context: vscode.ExtensionContext,
	tree: ControllerTreeProvider,
	deps: CloneDeps
): void {
	const secrets = context.secrets;
	const reg = (id: string, fn: (...args: any[]) => any) =>
		context.subscriptions.push(vscode.commands.registerCommand(id, fn));

	// --- Klonen / Klon aktualisieren -------------------------------------------

	reg('fanucLs.clone.create', async (node?: ControllerNode) => {
		const controller = node?.controller ?? (await deps.pickController());
		if (!controller) {
			return;
		}
		const devices = await vscode.window.showQuickPick(
			devicesOf(controller).map((d) => ({ label: d, picked: d.toLowerCase() === 'md:' })),
			{ canPickMany: true, placeHolder: `Welche Geräte von ${controller.name} klonen?` }
		);
		if (!devices || devices.length === 0) {
			return;
		}
		const base = await deps.resolveDownloadDir();
		if (!base) {
			return;
		}
		const root = path.join(base, sanitize(controller.name));
		const types = vscode.workspace.getConfiguration('fanucLs').get<string[]>('clone.fileTypes', []) ?? [];

		const existing = await readManifest(root);
		if (existing && existing.controller !== controller.name) {
			vscode.window.showErrorMessage(`${root} ist bereits ein Klon von "${existing.controller}".`);
			return;
		}
		const localChanges = existing ? await computeChanges(root, existing) : [];
		const protectedFiles = new Set(localChanges.filter((c) => c.kind !== 'deleted').map((c) => c.relPath));
		if (protectedFiles.size > 0) {
			const go = await vscode.window.showWarningMessage(
				`Im Klon gibt es ${protectedFiles.size} lokal geänderte oder neue Dateien. Diese werden beim Aktualisieren nicht überschrieben. Fortfahren?`,
				{ modal: true },
				'Aktualisieren'
			);
			if (go !== 'Aktualisieren') {
				return;
			}
		}

		const manifest: CloneManifest = existing ?? {
			version: 1,
			controller: controller.name,
			host: controller.host,
			created: new Date().toISOString(),
			updated: '',
			devices: {},
			files: {}
		};

		let loaded = 0;
		let skipped = 0;
		await deps.withProgress(`${controller.name} wird geklont`, async (progress) => {
			await fs.mkdir(root, { recursive: true });
			for (const { label: device } of devices) {
				const folder = deviceFolder(device);
				manifest.devices[folder] = device;
				const remoteFiles: { remotePath: string; inDevice: string }[] = [];
				progress.report({ message: `${device} wird gelesen` });
				await collect(controller, device, '', 0, types, remoteFiles);
				let i = 0;
				for (const f of remoteFiles) {
					i++;
					const rel = `${folder}/${f.inDevice}`;
					if (protectedFiles.has(rel)) {
						skipped++;
						continue;
					}
					progress.report({ message: `${device} ${i}/${remoteFiles.length}  ${f.inDevice}` });
					const local = path.join(root, folder, ...f.inDevice.split('/'));
					await fs.mkdir(path.dirname(local), { recursive: true });
					await ftp.downloadToFile(controller, secrets, f.remotePath, local);
					const stat = await fs.stat(local);
					manifest.files[rel] = {
						remotePath: f.remotePath,
						sha1: await sha1File(local),
						size: stat.size,
						robotHash: contentHash(await fs.readFile(local), path.basename(local))
					};
					deps.rememberOrigin(local, { controller: controller.name, remotePath: f.remotePath });
					loaded++;
				}
			}
			await writeManifest(root, manifest);
		});

		const note = skipped ? ` ${skipped} lokal geänderte Datei(en) wurden nicht überschrieben.` : '';
		const action = await vscode.window.showInformationMessage(
			`${controller.name}: ${loaded} Dateien nach ${root} geklont.${note}`,
			'Im Explorer zeigen',
			'Änderungen anzeigen'
		);
		if (action === 'Im Explorer zeigen') {
			await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path.join(root, MANIFEST_NAME)));
		} else if (action === 'Änderungen anzeigen') {
			await vscode.commands.executeCommand('fanucLs.clone.showChanges', vscode.Uri.file(root));
		}
	});

	// --- Änderungen anzeigen --------------------------------------------------

	reg('fanucLs.clone.showChanges', async (uri?: vscode.Uri) => {
		const clone = await pickClone(uri);
		if (!clone) {
			return;
		}
		const changes = await computeChanges(clone.root, clone.manifest);
		if (changes.length === 0) {
			vscode.window.showInformationMessage(`Klon von ${clone.manifest.controller}: keine lokalen Änderungen.`);
			return;
		}
		const pushItem = {
			label: `$(cloud-upload) Änderungen auf ${clone.manifest.controller} übertragen …`,
			change: undefined as CloneChange | undefined
		};
		const reportItem = {
			label: '$(output) Änderungsbericht erstellen',
			description: 'Übersicht aller Änderungen gegenüber dem Roboter',
			change: undefined as CloneChange | undefined
		};
		const picked = await vscode.window.showQuickPick(
			[pushItem, reportItem, ...changes.map((c) => ({ ...changeItem(c), change: c as CloneChange | undefined }))],
			{
				placeHolder: `${changes.length} Änderungen im Klon von ${clone.manifest.controller} - Datei wählen für den Vergleich`,
				matchOnDescription: true
			}
		);
		if (!picked) {
			return;
		}
		if (picked === reportItem) {
			await vscode.commands.executeCommand('fanucLs.clone.report', vscode.Uri.file(clone.root));
			return;
		}
		if (!picked.change) {
			await vscode.commands.executeCommand('fanucLs.clone.pushChanges', vscode.Uri.file(clone.root));
			return;
		}
		const c = picked.change;
		const local = path.join(clone.root, ...c.relPath.split('/'));
		if (c.kind === 'modified') {
			const controller = findController(clone.manifest);
			if (controller) {
				await deps.showDiff(controller, c.remotePath, local);
			}
		} else if (c.kind === 'added') {
			await vscode.window.showTextDocument(vscode.Uri.file(local));
		} else {
			vscode.window.showInformationMessage(
				`${c.relPath} wurde lokal gelöscht. Auf der Steuerung bleibt die Datei erhalten; Löschen nur über die Controller-Ansicht.`
			);
		}
	});

	// --- Änderungsbericht (#24) -------------------------------------------------

	reg('fanucLs.clone.report', async (uri?: vscode.Uri) => {
		const clone = await pickClone(uri);
		if (!clone) {
			return;
		}
		const controller = findController(clone.manifest);
		if (!controller) {
			return;
		}
		const changes = await computeChanges(clone.root, clone.manifest);
		const entries: ReportEntry[] = [];
		await deps.withProgress(`Änderungsbericht für ${controller.name}`, async (progress) => {
			const tmp = path.join(os.tmpdir(), 'fanuc-ls', 'clone-check');
			await fs.mkdir(tmp, { recursive: true });
			let i = 0;
			for (const change of changes) {
				i++;
				progress.report({ message: `${i}/${changes.length}  ${change.relPath}` });
				const local = path.join(clone.root, ...change.relPath.split('/'));
				const entry: ReportEntry = { change, conflict: false };
				if (change.kind !== 'deleted') {
					entry.localText = await fs.readFile(local, 'latin1').catch(() => undefined);
				}
				const probe = path.join(tmp, sanitize(change.remotePath));
				try {
					await ftp.downloadToFile(controller, secrets, change.remotePath, probe);
					entry.robotText = await fs.readFile(probe, 'latin1');
					if (change.kind !== 'deleted' && entry.localText !== undefined) {
						const name = path.basename(change.relPath);
						const check = classifyChange(
							change.kind,
							contentHash(entry.localText, name),
							{ hash: contentHash(entry.robotText, name), sha1: await sha1File(probe) },
							clone.manifest.files[change.relPath]
						);
						entry.conflict = check.state === 'conflict';
						entry.same = check.state === 'same';
					}
				} catch (err) {
					if (change.kind !== 'added') {
						entry.error = 'auf dem Roboter nicht lesbar';
					}
				}
				entries.push(entry);
			}
		});
		const md = buildReport(
			{ controller: controller.name, cloneRoot: clone.root, created: new Date(), clonedAt: clone.manifest.updated },
			entries
		);
		const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
		await vscode.window.showTextDocument(doc, { preview: false });
		await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri);
	});

	// --- Änderungen übertragen ------------------------------------------------

	reg('fanucLs.clone.pushChanges', async (uri?: vscode.Uri) => {
		const clone = await pickClone(uri);
		if (!clone) {
			return;
		}
		const controller = findController(clone.manifest);
		if (!controller) {
			return;
		}
		await pushWizard(clone, controller);
	});

	/**
	 * Übertragen als Assistent (#30): erst mit dem Roboter abgleichen (inhaltlich, nicht byteweise),
	 * dann Dateien ankreuzen, je Datei vergleichen, übertragen und das Ergebnis je Datei zeigen.
	 */
	async function pushWizard(clone: { root: string; manifest: CloneManifest }, controller: ControllerConfig): Promise<void> {
		const all = (await computeChanges(clone.root, clone.manifest)).filter((c) => c.kind !== 'deleted');
		if (all.length === 0) {
			vscode.window.showInformationMessage(`Klon von ${controller.name}: keine geänderten oder neuen Dateien zum Übertragen.`);
			return;
		}
		const w = new Wizard(`Übertragen → ${controller.name}`);
		const tmp = path.join(os.tmpdir(), 'fanuc-ls', 'clone-check');
		await fs.mkdir(tmp, { recursive: true });

		interface Row {
			change: CloneChange;
			local: string;
			check: SyncCheck;
			errors: number;
			readOnly: boolean;
		}
		const rows: Row[] = [];
		let i = 0;
		for (const change of all) {
			i++;
			w.busy(`Abgleich mit ${controller.name}: ${i} von ${all.length} – ${change.relPath}`);
			const local = path.join(clone.root, ...change.relPath.split('/'));
			const name = path.basename(change.relPath);
			if (isReadOnlyReport(name)) {
				rows.push({ change, local, readOnly: true, errors: 0, check: { state: 'same', reason: 'Diagnosedatei der Steuerung – lässt sich nicht hochladen' } });
				continue;
			}
			const localBuf = await fs.readFile(local);
			let robot: { hash: string; sha1: string } | undefined;
			const probe = path.join(tmp, sanitize(change.remotePath));
			try {
				await ftp.downloadToFile(controller, secrets, change.remotePath, probe);
				robot = { hash: contentHash(await fs.readFile(probe), name), sha1: await sha1File(probe) };
			} catch {
				robot = undefined;
			}
			const check = classifyChange(change.kind, contentHash(localBuf, name), robot, clone.manifest.files[change.relPath]);
			rows.push({ change, local, check, errors: await deps.countErrors(local), readOnly: false });
			if (check.state === 'same' && robot) {
				// Inhaltlich gleich: als abgeglichen merken, damit die Datei nicht mehr als Änderung erscheint
				clone.manifest.files[change.relPath] = { remotePath: change.remotePath, sha1: await sha1File(local), size: localBuf.length, robotHash: robot.hash };
			}
		}
		await writeManifest(clone.root, clone.manifest);
		if (w.closed) {
			return;
		}

		w.onCommand = (cmd, arg) => {
			const row = rows[Number(arg)];
			if (cmd === 'diff' && row) {
				void deps.showDiff(controller, row.change.remotePath, row.local, w.editorColumn);
			} else if (cmd === 'open' && row) {
				void vscode.window.showTextDocument(vscode.Uri.file(row.local), { viewColumn: w.editorColumn });
			} else if (cmd === 'report') {
				void vscode.commands.executeCommand('fanucLs.clone.report', vscode.Uri.file(clone.root));
			}
		};
		const label: Record<SyncState, string> = { changed: '✏️ geändert', new: '🆕 neu', same: '＝ gleich', conflict: '⚠️ Konflikt' };
		const candidates = rows.filter((r) => !r.readOnly && r.check.state !== 'same');
		let selected = new Set(rows.map((r, k) => (candidates.includes(r) && r.check.state !== 'conflict' ? k : -1)).filter((k) => k >= 0));
		let error: string | undefined;
		let confirmed = false;
		for (;;) {
			const table =
				'<table><tr><th></th><th>Datei (PC-Klon → Roboter)</th><th>Status</th><th></th></tr>' +
				rows
					.map((r, k) => {
						const box = candidates.includes(r) ? `<input type="checkbox" name="f" value="${k}"${selected.has(k) ? ' checked' : ''}>` : '';
						const errs = r.errors ? `<br><small>⚠️ ${r.errors} Syntaxfehler</small>` : '';
						const cmp = r.check.state === 'new' || r.readOnly ? button('Öffnen', 'cmd:open', { arg: String(k) }) : button('Vergleichen', 'cmd:diff', { arg: String(k) });
						return `<tr><td>${box}</td><td><code>${esc(r.change.relPath)}</code><br><small>→ ${esc(r.change.remotePath)}</small></td><td>${label[r.check.state]}<br><small>${esc(r.check.reason)}</small>${errs}</td><td>${cmp}</td></tr>`;
					})
					.join('') +
				'</table>';
			const same = rows.filter((r) => r.check.state === 'same' && !r.readOnly).length;
			const r = await w.step(
				page({
					progress: [1, 2],
					title: 'Was soll auf den Roboter?',
					intro:
						`Abgeglichen mit dem aktuellen Stand auf <b>${esc(controller.name)}</b>. Verglichen wird der <b>Inhalt</b>: Datum und Größe im Programmkopf, ` +
						'E/A- und Registerkommentare (<code>DO[12:…]</code>), Zeilennummern und Leerzeichen zählen nicht. ' +
						'<b>Vergleichen</b> zeigt links den Roboter (jetzt geladen), rechts die Datei im Klon.',
					error,
					content:
						(same ? message('info', `${same} Datei(en) sind inhaltlich gleich wie auf dem Roboter und werden nicht übertragen.`) : '') +
						(rows.some((x) => x.check.state === 'conflict')
							? message('warn', '<b>Konflikt:</b> Die Datei wurde auch auf dem Roboter geändert oder gibt es dort schon. Beim Übertragen gehen die Änderungen auf dem Roboter verloren – erst vergleichen, nur bewusst ankreuzen.')
							: '') +
						table,
					buttons:
						(candidates.length ? button('📤 Ausgewählte übertragen', 'go', { primary: true }) : '') +
						button('Änderungsbericht', 'cmd:report') +
						cancelButton()
				})
			);
			if (r.act !== 'go') {
				return w.close();
			}
			selected = new Set(list(r.values.f).map(Number));
			if (selected.size === 0) {
				error = 'Bitte mindestens eine Datei ankreuzen.';
				continue;
			}
			const risky = [...selected].map((k) => rows[k]).filter((x) => x.check.state === 'conflict' || x.errors > 0);
			if (risky.length && !confirmed) {
				const c = await w.step(
					page({
						title: 'Wirklich übertragen?',
						content: message(
							'warn',
							`Bei diesen Dateien bitte bewusst bestätigen:<ul>${risky
								.map((x) => `<li><code>${esc(x.change.relPath)}</code> – ${x.check.state === 'conflict' ? esc(x.check.reason) + ' (wird überschrieben)' : ''}${x.errors ? ` ${x.errors} Syntaxfehler` : ''}</li>`)
								.join('')}</ul>`
						),
						buttons: button('Trotzdem übertragen', 'yes', { danger: true }) + button('← Zurück', 'back')
					})
				);
				if (c.act !== 'yes') {
					if (c.act === 'cancel') {
						return w.close();
					}
					continue;
				}
				confirmed = true;
			}
			break;
		}

		const done: Row[] = [];
		const failed: { row: Row; reason: string }[] = [];
		const chosen = [...selected].sort((x, y) => x - y).map((k) => rows[k]);
		let n = 0;
		for (const row of chosen) {
			n++;
			w.busy(`Übertragen ${n} von ${chosen.length}: ${row.change.relPath}`);
			const name = path.basename(row.change.relPath);
			try {
				await ftp.uploadFile(controller, secrets, row.local, row.change.remotePath);
				// Stand merken, den die Steuerung daraus erzeugt (bei .LS neu formatiert)
				let robotHash = contentHash(await fs.readFile(row.local), name);
				const probe = path.join(tmp, sanitize(row.change.remotePath));
				try {
					await ftp.downloadToFile(controller, secrets, row.change.remotePath, probe);
					robotHash = contentHash(await fs.readFile(probe), name);
				} catch {
					// nicht lesbar: lokalen Inhalt annehmen
				}
				const stat = await fs.stat(row.local);
				clone.manifest.files[row.change.relPath] = { remotePath: row.change.remotePath, sha1: await sha1File(row.local), size: stat.size, robotHash };
				deps.rememberOrigin(row.local, { controller: controller.name, remotePath: row.change.remotePath });
				done.push(row);
			} catch (err) {
				failed.push({ row, reason: err instanceof Error ? err.message : String(err) });
			}
			await writeManifest(clone.root, clone.manifest);
		}
		tree.refresh();
		deps.programsChanged(controller.name);
		const notChosen = rows.filter((x) => !chosen.includes(x));
		await w.step(
			page({
				progress: [2, 2],
				title: failed.length ? 'Übertragung mit Fehlern' : 'Übertragung fertig',
				content:
					(done.length ? message('ok', `<b>${done.length} Datei(en) übertragen:</b><br>${done.map((x) => `<code>${esc(x.change.relPath)}</code>`).join(', ')}`) : '') +
					(failed.length
						? message('error', `<b>${failed.length} Datei(en) nicht übertragen:</b><ul>${failed.map((f) => `<li><code>${esc(f.row.change.relPath)}</code>: ${esc(f.reason)}</li>`).join('')}</ul>`)
						: '') +
					(notChosen.length
						? message('info', `<b>Nicht übertragen (nicht ausgewählt):</b><ul>${notChosen.map((x) => `<li><code>${esc(x.change.relPath)}</code> – ${esc(x.check.reason)}</li>`).join('')}</ul>`)
						: ''),
				buttons: button('Fertig', 'done', { primary: true })
			})
		);
		w.close();
	}

	// --- Hilfsfunktionen ------------------------------------------------------

	async function collect(
		controller: ControllerConfig,
		remoteDir: string,
		relDir: string,
		depth: number,
		types: string[],
		out: { remotePath: string; inDevice: string }[]
	): Promise<void> {
		const entries = await ftp.list(controller, secrets, remoteDir);
		for (const e of entries) {
			const remotePath = ftp.joinRemote(remoteDir, e.name);
			const inDevice = relDir ? `${relDir}/${e.name}` : e.name;
			if (e.isDirectory) {
				if (depth < MAX_DEPTH) {
					await collect(controller, remotePath, inDevice, depth + 1, types, out);
				}
			} else if (matchesTypes(e.name, types)) {
				out.push({ remotePath, inDevice });
			}
		}
	}

	function findController(manifest: CloneManifest): ControllerConfig | undefined {
		const c = getControllers().find((x) => x.name === manifest.controller);
		if (!c) {
			vscode.window.showErrorMessage(
				`Controller "${manifest.controller}" ist nicht mehr konfiguriert. Bitte unter diesem Namen wieder anlegen.`
			);
		}
		return c;
	}

	async function pickClone(uri?: vscode.Uri): Promise<{ root: string; manifest: CloneManifest } | undefined> {
		const start = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
		if (start) {
			const found = await findCloneRoot(start);
			if (found) {
				return found;
			}
		}
		const files = await vscode.workspace.findFiles(`**/${MANIFEST_NAME}`, '**/node_modules/**', 50);
		const clones: { root: string; manifest: CloneManifest }[] = [];
		for (const f of files) {
			const root = path.dirname(f.fsPath);
			const manifest = await readManifest(root);
			if (manifest) {
				clones.push({ root, manifest });
			}
		}
		if (clones.length === 1) {
			return clones[0];
		}
		if (clones.length > 1) {
			const picked = await vscode.window.showQuickPick(
				clones.map((c) => ({
					label: c.manifest.controller,
					description: vscode.workspace.asRelativePath(c.root),
					value: c
				})),
				{ placeHolder: 'Klon wählen' }
			);
			return picked?.value;
		}
		const action = await vscode.window.showInformationMessage(
			'Im Workspace wurde kein Controller-Klon gefunden.',
			'Controller klonen'
		);
		if (action) {
			await vscode.commands.executeCommand('fanucLs.clone.create');
		}
		return undefined;
	}
}

function changeItem(c: CloneChange): vscode.QuickPickItem {
	const icon = c.kind === 'modified' ? '$(diff-modified)' : c.kind === 'added' ? '$(diff-added)' : '$(diff-removed)';
	const what = c.kind === 'modified' ? 'geändert' : c.kind === 'added' ? 'neu' : 'lokal gelöscht';
	return { label: `${icon} ${c.relPath}`, description: `${what}  →  ${c.remotePath}` };
}

function sanitize(s: string): string {
	return s.replace(/[^A-Za-z0-9_.-]+/g, '_');
}
