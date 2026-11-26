/**
 * Mehrere Dateien auf einen Roboter laden und Programme an einen Roboter (Softwarestand,
 * Optionen) anpassen. Beide Assistenten laufen in der Oberfläche "FANUC Roboter".
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ControllerConfig, devicesOf, getControllers } from './config';
import { FanucApi } from './commands';
import * as ftp from './ftp';
import { isReadOnlyReport } from './ioKarel';
import { AdaptResult, adaptHeader, calledPrograms, uploadOrder } from './lsHeader';
import { Wizard, backButton, button, cancelButton, esc, filterBox, list, message, page, radioCard, str } from './welderUi';
import { ftpErrorText, pickRobot } from './welder';

/** Dateien, die sich auf eine Steuerung laden lassen */
const LOADABLE = /\.(ls|tp|pc|dt|vr|va|sv|io)$/i;
const GLOB = '**/*.{ls,LS,Ls,tp,TP,pc,PC,dt,DT,vr,VR}';

interface Reference {
	/** Anzeige, z. B. "R1: md:SCHWEISS1.LS" */
	label: string;
	text: string;
}

export function registerMultiUpload(context: vscode.ExtensionContext, api: FanucApi): void {
	const reg = (id: string, fn: (...args: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
	reg('fanucLs.welder.uploadMany', (uri?: vscode.Uri, uris?: vscode.Uri[]) => uploadManyWizard(api, selection(uri, uris)));
	reg('fanucLs.welder.adaptPrograms', (uri?: vscode.Uri, uris?: vscode.Uri[]) => adaptWizard(api, selection(uri, uris)));
}

function selection(uri?: vscode.Uri, uris?: vscode.Uri[]): string[] {
	const all = uris?.length ? uris : uri instanceof vscode.Uri ? [uri] : [];
	return all.filter((u) => u.scheme === 'file').map((u) => u.fsPath);
}

// --- Bausteine -------------------------------------------------------------------------------

/** Dateiauswahl mit Häkchen (Arbeitsbereich + selbst gewählte Dateien). */
async function pickFiles(
	w: Wizard,
	progress: [number, number],
	title: string,
	intro: string,
	preselected: string[],
	filter: RegExp
): Promise<string[] | undefined> {
	const found = (await vscode.workspace.findFiles(GLOB, '**/{node_modules,.git}/**', 2000)).map((u) => u.fsPath).filter((f) => filter.test(f));
	let files = [...new Set([...preselected.filter((f) => filter.test(f)), ...found])];
	let chosen = new Set(preselected);
	let error: string | undefined;
	for (;;) {
		const rows = files
			.map((f, i) => {
				const rel = vscode.workspace.asRelativePath(f);
				return `<label class="choice filterable"><input type="checkbox" name="f" value="${i}"${chosen.has(f) ? ' checked' : ''}><span><strong>${esc(path.basename(f))}</strong><small>${esc(rel)}</small></span></label>`;
			})
			.join('');
		const r = await w.step(
			page({
				progress,
				title,
				intro,
				error,
				content:
					(files.length > 8 ? filterBox('Dateiname suchen …') : '') +
					(files.length ? rows : message('info', 'Im geöffneten Ordner wurden keine passenden Dateien gefunden. Über „Weitere Dateien …“ auswählen.')),
				buttons: button('📂 Weitere Dateien …', 'browse') + button('Weiter →', 'next', { primary: true }) + cancelButton()
			})
		);
		chosen = new Set(list(r.values.f).map((i) => files[Number(i)]));
		if (r.act === 'browse') {
			const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Hinzufügen', filters: { 'FANUC-Dateien': ['ls', 'LS', 'tp', 'TP', 'pc', 'PC', 'dt', 'DT', 'vr', 'VR'], Alle: ['*'] } });
			for (const u of picked ?? []) {
				if (!files.includes(u.fsPath)) {
					files = [u.fsPath, ...files];
				}
				chosen.add(u.fsPath);
			}
			continue;
		}
		if (r.act !== 'next') {
			return undefined;
		}
		if (chosen.size === 0) {
			error = 'Bitte mindestens eine Datei ankreuzen.';
			continue;
		}
		return files.filter((f) => chosen.has(f));
	}
}

/** Programm (.LS) vom Roboter als Vorlage: eines, zu dem es auch ein .TP gibt. */
async function referenceFromRobot(api: FanucApi, c: ControllerConfig, device: string, wanted?: string): Promise<Reference | undefined> {
	const entries = (await ftp.list(c, api.secrets, device)).filter((e) => !e.isDirectory);
	const names = new Set(entries.map((e) => e.name.toUpperCase()));
	const ls = entries
		.map((e) => e.name)
		.filter((n) => /\.ls$/i.test(n) && !isReadOnlyReport(n) && names.has(n.replace(/\.ls$/i, '.TP').toUpperCase()));
	const name = wanted ? ls.find((n) => n.toUpperCase() === wanted.toUpperCase()) : ls[0];
	if (!name) {
		return undefined;
	}
	const tmp = path.join(os.tmpdir(), 'fanuc-ls', 'reference', sanitize(c.name));
	await fs.mkdir(tmp, { recursive: true });
	const file = path.join(tmp, name);
	await ftp.downloadToFile(c, api.secrets, ftp.joinRemote(device, name), file);
	return { label: `${c.name}: ${ftp.joinRemote(device, name)}`, text: await fs.readFile(file, 'latin1') };
}

async function listLsOnRobot(api: FanucApi, c: ControllerConfig, device: string): Promise<string[]> {
	const entries = (await ftp.list(c, api.secrets, device)).filter((e) => !e.isDirectory);
	const names = new Set(entries.map((e) => e.name.toUpperCase()));
	return entries.map((e) => e.name).filter((n) => /\.ls$/i.test(n) && !isReadOnlyReport(n) && names.has(n.replace(/\.ls$/i, '.TP').toUpperCase()));
}

function adaptSummary(a: AdaptResult | undefined): string {
	if (!a) {
		return '';
	}
	if (!a.changed && !a.warnings.length) {
		return 'Kopf passt';
	}
	const parts = [
		a.added.length ? `+ ${a.added.join(', ')}` : '',
		a.removed.length ? `− ${a.removed.join(', ')}` : '',
		...a.warnings.map((x) => `⚠️ ${x}`)
	].filter(Boolean);
	return parts.join('<br>');
}

function sanitize(s: string): string {
	return s.replace(/[^\p{L}\p{N}_.-]+/gu, '_');
}

// --- Mehrere Dateien auf den Roboter laden -------------------------------------------------------

async function uploadManyWizard(api: FanucApi, preselected: string[]): Promise<void> {
	const w = new Wizard('Mehrere Dateien auf Roboter laden');
	const total = 4;
	const files = await pickFiles(
		w,
		[1, total],
		'Welche Dateien laden?',
		'Ankreuzen, was auf den Roboter soll (TP-Programme <code>.LS</code>, <code>.TP</code>, KAREL <code>.PC</code>, <code>.DT</code>, <code>.VR</code>). Mehrfachauswahl geht auch im Explorer: Dateien markieren → Rechtsklick → <i>Ausgewählte Dateien auf Roboter laden</i>.',
		preselected,
		LOADABLE
	);
	if (!files) {
		return w.close();
	}

	// Roboter, Gerät, Anpassung
	let robot: ControllerConfig | undefined;
	let device = 'md:';
	let adapt = false;
	let error: string | undefined;
	for (;;) {
		const robots = getControllers();
		if (!robots.length) {
			const p = await pickRobot(w, api, [2, total], 'Auf welchen Roboter?');
			if (!p || p === 'back') {
				return w.close();
			}
		}
		const all = getControllers();
		robot = robot ?? all[0];
		const devices = [...new Set([...(robot ? devicesOf(robot) : []), 'md:'])];
		const hasLs = files.some((f) => /\.ls$/i.test(f));
		const r = await w.step(
			page({
				progress: [2, total],
				title: 'Wohin?',
				error,
				content:
					'<h2>Roboter</h2>' +
					all.map((c) => radioCard('robot', c.name, c.name, esc(c.host), c.name === robot?.name)).join('') +
					'<h2>Speicher</h2>' +
					devices.map((d) => radioCard('device', d, d, d === 'md:' ? 'Programmspeicher (empfohlen)' : '', d === device)).join('') +
					(hasLs
						? '<h2>An den Roboter anpassen</h2>' +
							radioCard('adapt', 'no', 'Unverändert laden', 'Die Dateien werden so geladen, wie sie sind.', !adapt) +
							radioCard(
								'adapt',
								'yes',
								'Programmkopf an den Roboter anpassen',
								'Für Programme von einem Roboter mit anderem Softwarestand oder anderen Optionen: Kopfeinträge (z. B. <code>LOCAL_REGISTERS</code>, TCD) werden wie bei einem Programm dieses Roboters gesetzt. Die Dateien am PC bleiben unverändert.',
								adapt
							)
						: ''),
				buttons: button('Prüfen →', 'next', { primary: true }) + cancelButton()
			})
		);
		if (r.act !== 'next') {
			return w.close();
		}
		robot = all.find((c) => c.name === str(r.values.robot)) ?? robot;
		device = str(r.values.device) || device;
		adapt = str(r.values.adapt) === 'yes';
		if (!robot) {
			error = 'Bitte einen Roboter wählen.';
			continue;
		}
		break;
	}
	const c = robot!;

	// Prüfen: Syntax, vorhanden, Anpassung, Reihenfolge
	interface Row {
		file: string;
		name: string;
		remote: string;
		errors: number;
		exists: boolean;
		readOnly: boolean;
		adapted?: AdaptResult;
		uploadFrom: string;
	}
	let rows: Row[] = [];
	let reference: Reference | undefined;
	try {
		w.busy(`Verbindung zu ${c.name} …`);
		const existing = new Set((await ftp.list(c, api.secrets, device)).map((e) => e.name.toUpperCase()));
		if (adapt) {
			w.busy(`Vorlage von ${c.name} wird geladen …`);
			reference = await referenceFromRobot(api, c, 'md:');
		}
		const tmp = path.join(os.tmpdir(), 'fanuc-ls', 'upload', sanitize(c.name));
		await fs.mkdir(tmp, { recursive: true });
		const calls = new Map<string, string[]>();
		for (const file of files) {
			const name = path.basename(file);
			w.busy(`Prüfen: ${name}`);
			const row: Row = { file, name, remote: ftp.joinRemote(device, name), errors: 0, exists: existing.has(name.toUpperCase()), readOnly: isReadOnlyReport(name), uploadFrom: file };
			if (/\.ls$/i.test(name)) {
				const doc = await vscode.workspace.openTextDocument(file);
				if (doc.isDirty) {
					await doc.save();
				}
				row.errors = (await api.check(doc)).filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
				const text = await fs.readFile(file, 'latin1');
				calls.set(name.replace(/\.ls$/i, '').toUpperCase(), calledPrograms(text));
				if (reference) {
					row.adapted = adaptHeader(text, reference.text);
					if (row.adapted.changed) {
						row.uploadFrom = path.join(tmp, name);
						await fs.writeFile(row.uploadFrom, row.adapted.text, 'latin1');
					}
				}
			}
			rows.push(row);
		}
		// aufgerufene Programme zuerst laden
		const key = (r: Row) => r.name.replace(/\.[^.]+$/, '').toUpperCase();
		const order = uploadOrder(rows.map(key), calls);
		rows = [...rows].sort((a, b) => order.indexOf(key(a)) - order.indexOf(key(b)) || a.name.localeCompare(b.name));
	} catch (err) {
		await w.step(page({ title: 'Keine Verbindung', content: message('error', ftpErrorText(err)), buttons: button('Schließen', 'cancel') }));
		return w.close();
	}

	w.onCommand = (cmd, arg) => {
		const row = rows[Number(arg)];
		if (cmd === 'diff' && row?.adapted?.changed) {
			void vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(row.file), vscode.Uri.file(row.uploadFrom), `${row.name}: PC ↔ angepasst für ${c.name}`, { viewColumn: w.editorColumn });
		}
	};
	let selected = new Set(rows.map((r, i) => (r.errors || r.readOnly ? -1 : i)).filter((i) => i >= 0));
	let confirm = false;
	let err2: string | undefined;
	for (;;) {
		const table =
			'<table><tr><th></th><th>Datei → Ziel</th><th>Status</th></tr>' +
			rows
				.map((r, i) => {
					const status = [
						r.readOnly ? '⛔ Diagnosedatei der Steuerung, lässt sich nicht laden' : '',
						r.errors ? `⚠️ ${r.errors} Syntaxfehler` : '',
						r.exists ? 'wird <b>ersetzt</b>' : 'neu',
						r.adapted ? adaptSummary(r.adapted) : ''
					]
						.filter(Boolean)
						.join('<br>');
					const diff = r.adapted?.changed ? ' ' + button('Anpassung zeigen', 'cmd:diff', { arg: String(i) }) : '';
					return `<tr><td>${r.readOnly ? '' : `<input type="checkbox" name="f" value="${i}"${selected.has(i) ? ' checked' : ''}>`}</td><td><b>${esc(r.name)}</b><br><small>→ ${esc(r.remote)}</small></td><td><small>${status}</small>${diff}</td></tr>`;
				})
				.join('') +
			'</table>';
		const r = await w.step(
			page({
				progress: [3, total],
				title: `Auf ${c.name} laden?`,
				intro: `Reihenfolge: aufgerufene Programme (CALL/RUN) zuerst. Programme dürfen am Roboter nicht ausgewählt sein oder laufen.`,
				error: err2,
				content:
					(adapt
						? reference
							? message('info', `Vorlage für die Anpassung: <code>${esc(reference.label)}</code>. Geladen wird eine angepasste Kopie; die Dateien am PC bleiben unverändert.`)
							: message('warn', `Auf ${esc(c.name)} wurde kein Programm (.LS mit .TP) als Vorlage gefunden – die Dateien werden unverändert geladen.`)
						: '') +
					(rows.some((x) => x.errors) ? message('warn', 'Dateien mit Syntaxfehlern sind nicht angekreuzt.') : '') +
					table,
				buttons: backButton() + button(`📤 Ausgewählte laden`, 'go', { primary: true }) + cancelButton()
			})
		);
		if (r.act === 'back' || r.act === 'cancel') {
			return w.close();
		}
		selected = new Set(list(r.values.f).map(Number));
		if (!selected.size) {
			err2 = 'Bitte mindestens eine Datei ankreuzen.';
			continue;
		}
		const risky = [...selected].map((i) => rows[i]).filter((x) => x.errors);
		if (risky.length && !confirm) {
			const q = await w.step(
				page({
					title: 'Mit Syntaxfehlern laden?',
					content: message('warn', `Diese Dateien haben Syntaxfehler und werden vom Roboter vermutlich abgelehnt: ${risky.map((x) => `<code>${esc(x.name)}</code>`).join(', ')}`),
					buttons: button('Trotzdem laden', 'yes', { danger: true }) + backButton()
				})
			);
			if (q.act !== 'yes') {
				if (q.act === 'cancel') {
					return w.close();
				}
				continue;
			}
			confirm = true;
		}
		break;
	}

	const chosen = rows.filter((_, i) => selected.has(i));
	const done: Row[] = [];
	const failed: { row: Row; reason: string }[] = [];
	let n = 0;
	for (const row of chosen) {
		n++;
		w.busy(`${n} von ${chosen.length}: ${row.name} → ${c.name}`);
		try {
			await api.upload(row.uploadFrom, c, row.remote);
			if (row.uploadFrom === row.file) {
				api.rememberOrigin(row.file, { controller: c.name, remotePath: row.remote });
			}
			done.push(row);
		} catch (err) {
			failed.push({ row, reason: err instanceof Error ? err.message : String(err) });
		}
	}
	api.refresh();
	await w.step(
		page({
			progress: [4, total],
			title: failed.length ? 'Laden mit Fehlern' : 'Alle Dateien geladen',
			content:
				(done.length ? message('ok', `<b>${done.length} Datei(en) auf ${esc(c.name)} geladen:</b><br>${done.map((x) => `<code>${esc(x.name)}</code>${x.uploadFrom !== x.file ? ' (angepasst)' : ''}`).join(', ')}`) : '') +
				(failed.length ? message('error', `<b>${failed.length} nicht geladen:</b><ul>${failed.map((f) => `<li><code>${esc(f.row.name)}</code>: ${esc(f.reason)}</li>`).join('')}</ul>`) : '') +
				message('warn', 'Vor dem Automatikbetrieb die Programme im Handbetrieb (T1) mit reduzierter Geschwindigkeit abfahren.'),
			buttons: button('Fertig', 'done', { primary: true })
		})
	);
	w.close();
}

// --- Programme an einen Roboter anpassen -----------------------------------------------------

async function adaptWizard(api: FanucApi, preselected: string[]): Promise<void> {
	const w = new Wizard('Programme an Roboter anpassen');
	const total = 4;

	// 1. Vorlage
	let reference: Reference | undefined;
	let robotForUpload: ControllerConfig | undefined;
	for (;;) {
		const robots = getControllers();
		const r = await w.step(
			page({
				progress: [1, total],
				title: 'Woher kommt die Vorlage?',
				intro:
					'Programme von einem Roboter mit anderem Softwarestand oder anderen Optionen werden oft nicht geladen, weil der Programmkopf andere Einträge hat ' +
					'(z. B. <code>LOCAL_REGISTERS</code> für lokale Register, Einträge im TCD-Block, <code>/APPL</code>-Blöcke). ' +
					'Ein beliebiges Programm vom Zielroboter dient als Vorlage: Seine Kopfstruktur wird auf die gewählten Programme übertragen, deren Werte (Kommentar, Gruppen, Priorität …) und der Programmteil bleiben.',
				content:
					robots.map((c) => `<button class="card compact" data-act="robot" data-arg="${esc(c.name)}"><span class="icon">🤖</span><span class="text"><strong>Programm von ${esc(c.name)}</strong><small>${esc(c.host)} · Programm aus der Liste wählen</small></span></button>`).join('') +
					'<button class="card compact" data-act="file"><span class="icon">📄</span><span class="text"><strong>Datei am PC</strong><small>Eine .LS, die vom Zielroboter stammt</small></span></button>',
				buttons: cancelButton()
			})
		);
		if (r.act === 'file') {
			const u = (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Als Vorlage verwenden', filters: { 'TP-Programme': ['ls', 'LS'] } }))?.[0];
			if (u) {
				reference = { label: vscode.workspace.asRelativePath(u), text: await fs.readFile(u.fsPath, 'latin1') };
				break;
			}
			continue;
		}
		if (r.act !== 'robot') {
			return w.close();
		}
		const c = robots.find((x) => x.name === r.arg);
		if (!c) {
			continue;
		}
		try {
			w.busy(`Programmliste von ${c.name} …`);
			const names = await listLsOnRobot(api, c, 'md:');
			if (!names.length) {
				await w.step(page({ title: 'Kein Programm gefunden', content: message('warn', `Auf ${esc(c.name)} (md:) gibt es kein TP-Programm als .LS.`), buttons: backButton() }));
				continue;
			}
			const p = await w.step(
				page({
					progress: [1, total],
					title: `Vorlage von ${c.name}`,
					intro: 'Ein beliebiges Programm wählen – es wird nur der Kopf gelesen.',
					content: (names.length > 8 ? filterBox('Programm suchen …') : '') + names.map((n) => `<button class="card compact filterable" data-act="pick" data-arg="${esc(n)}"><span class="icon">📄</span><span class="text"><strong>${esc(n)}</strong></span></button>`).join(''),
					buttons: backButton() + cancelButton()
				})
			);
			if (p.act === 'back') {
				continue;
			}
			if (p.act !== 'pick') {
				return w.close();
			}
			w.busy(`${p.arg} wird geladen …`);
			reference = await referenceFromRobot(api, c, 'md:', p.arg);
			robotForUpload = c;
			if (reference) {
				break;
			}
		} catch (err) {
			await w.step(page({ title: 'Keine Verbindung', content: message('error', ftpErrorText(err)), buttons: backButton() }));
		}
	}

	// 2. Programme
	const files = await pickFiles(w, [2, total], 'Welche Programme anpassen?', `Vorlage: <code>${esc(reference!.label)}</code>`, preselected, /\.ls$/i);
	if (!files) {
		return w.close();
	}

	// 3. Vorschau
	let appl = false;
	let mode: 'copy' | 'overwrite' = 'copy';
	const targetName = sanitize(robotForUpload?.name ?? path.basename(reference!.label).replace(/\.ls$/i, ''));
	const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(files[0]);
	const copyDir = path.join(base, 'angepasst', targetName);
	let results: { file: string; res: AdaptResult }[] = [];
	const tmp = path.join(os.tmpdir(), 'fanuc-ls', 'adapt');
	await fs.mkdir(tmp, { recursive: true });
	w.onCommand = (cmd, arg) => {
		const x = results[Number(arg)];
		if (cmd === 'diff' && x) {
			const out = path.join(tmp, path.basename(x.file));
			void fs.writeFile(out, x.res.text, 'latin1').then(() =>
				vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(x.file), vscode.Uri.file(out), `${path.basename(x.file)}: vorher ↔ angepasst`, { viewColumn: w.editorColumn })
			);
		}
	};
	for (;;) {
		results = [];
		for (const f of files) {
			results.push({ file: f, res: adaptHeader(await fs.readFile(f, 'latin1'), reference!.text, { appl }) });
		}
		const changed = results.filter((x) => x.res.changed).length;
		const table =
			'<table><tr><th>Programm</th><th>Änderung am Kopf</th><th></th></tr>' +
			results
				.map(
					(x, i) =>
						`<tr><td><b>${esc(path.basename(x.file))}</b></td><td><small>${adaptSummary(x.res)}${x.res.keptAppl.length ? `<br>bleibt: APPL ${esc(x.res.keptAppl.join(', '))}` : ''}</small></td><td>${x.res.changed ? button('Vergleichen', 'cmd:diff', { arg: String(i) }) : ''}</td></tr>`
				)
				.join('') +
			'</table>';
		const r = await w.step(
			page({
				progress: [3, total],
				title: `${changed} von ${results.length} Programmen werden angepasst`,
				intro: `Vorlage: <code>${esc(reference!.label)}</code>. Nur der Programmkopf ändert sich, Programmzeilen und Positionen bleiben.`,
				content:
					(results.some((x) => x.res.warnings.length) ? message('warn', 'Bei einigen Programmen reicht die Anpassung des Kopfes nicht – siehe ⚠️.') : '') +
					table +
					'<h2>Optionen</h2>' +
					`<label class="choice"><input type="checkbox" name="appl" value="1"${appl ? ' checked' : ''}><span><strong>/APPL-Abschnitt angleichen</strong><small>Fehlende Blöcke der Vorlage ergänzen (z. B. Arc-Tool-Ausrüstung). Eigene Blöcke der Programme bleiben.</small></span></label>` +
					'<h2>Speichern</h2>' +
					radioCard('mode', 'copy', 'Als Kopie speichern (empfohlen)', `In <code>${esc(vscode.workspace.asRelativePath(copyDir))}</code> – die Originale bleiben für den bisherigen Roboter.`, mode === 'copy') +
					radioCard('mode', 'overwrite', 'Originale überschreiben', 'Die gewählten Dateien werden geändert (Rückgängig über Git oder Sicherung).', mode === 'overwrite'),
				buttons: backButton() + button('Vorschau aktualisieren', 'refresh') + button('✔ Anpassen', 'go', { primary: true }) + cancelButton()
			})
		);
		appl = list(r.values.appl).length > 0;
		mode = str(r.values.mode) === 'overwrite' ? 'overwrite' : 'copy';
		if (r.act === 'refresh') {
			continue;
		}
		if (r.act !== 'go') {
			return w.close();
		}
		break;
	}

	// 4. Schreiben
	const written: string[] = [];
	if (mode === 'copy') {
		await fs.mkdir(copyDir, { recursive: true });
	}
	for (const x of results) {
		const out = mode === 'copy' ? path.join(copyDir, path.basename(x.file)) : x.file;
		if (mode === 'overwrite' && !x.res.changed) {
			continue;
		}
		await fs.writeFile(out, x.res.text, 'latin1');
		written.push(out);
	}
	w.onCommand = (cmd) => {
		if (cmd === 'reveal' && written.length) {
			void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(written[0]));
		}
	};
	const r = await w.step(
		page({
			progress: [4, total],
			title: 'Programme angepasst',
			content:
				message('ok', `<b>${written.length} Programm(e)</b> ${mode === 'copy' ? `gespeichert in <code>${esc(vscode.workspace.asRelativePath(copyDir))}</code>` : 'überschrieben'}.`) +
				(robotForUpload ? message('info', `Jetzt auf <b>${esc(robotForUpload.name)}</b> laden? Der nächste Schritt prüft die Programme noch einmal und zeigt, was ersetzt wird.`) : ''),
			buttons:
				button('📂 Im Explorer zeigen', 'cmd:reveal') +
				(written.length ? button('📤 Auf Roboter laden …', 'upload', { primary: true }) : '') +
				button('Fertig', 'done')
		})
	);
	w.close();
	if (r.act === 'upload') {
		await uploadManyWizard(api, written);
	}
}
