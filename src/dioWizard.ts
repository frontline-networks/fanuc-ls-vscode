/**
 * Assistent "Signal-Excel → DIOCFGSV.IO": E/A-Kommentare aus der Signal-Excel
 * (z. B. "Fanuc IO-Mapping") in die E/A-Konfiguration eines Roboters übernehmen.
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ControllerConfig, devicesOf, getControllers } from './config';
import { FanucApi } from './commands';
import * as ftp from './ftp';
import { readWorkbook } from './excelReader';
import { BuildResult, DioCfg, MAX_COMMENT, PORT_NAMES, PORT_TYPES, SourceReport, buildDioCfg, compareDioCfg, dioReport, portLabel, readSignalWorkbook } from './dioCfg';
import { IoStore } from './io';
import { normalizeIoType } from './ioCore';
import { ftpErrorText } from './welder';
import { Wizard, backButton, button, cancelButton, card, checkCard, esc, field, list, message, page, radioCard, str } from './welderUi';

const TOTAL = 5;

interface Template {
	buf: Buffer;
	/** Anzeige: Roboter bzw. Datei */
	label: string;
	controller?: ControllerConfig;
	/** lokale Datei (nicht überschreiben) */
	file?: string;
}

export function registerIoExcelWizard(context: vscode.ExtensionContext, api: FanucApi, store: IoStore): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('fanucLs.io.inspectDiocfg', async () => {
			try {
				await inspect(api);
			} catch (err) {
				vscode.window.showErrorMessage(`DIOCFGSV.IO prüfen: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
		vscode.commands.registerCommand('fanucLs.io.excelToDiocfg', async () => {
			try {
				await run(context, api, store);
			} catch (err) {
				vscode.window.showErrorMessage(`Excel → DIOCFGSV.IO: ${err instanceof Error ? err.message : String(err)}`);
			}
		})
	);
}

async function run(context: vscode.ExtensionContext, api: FanucApi, store: IoStore): Promise<void> {
	const w = new Wizard('Excel → E/A-Konfiguration');
	let excel: string | undefined = context.workspaceState.get<string>('fanucLs.ioExcel.last');
	let report: SourceReport | undefined;
	let commentColumn = 'Signal Name';
	let types: number[] = [];
	let template: Template | undefined;
	let replace = false;
	let onlyAssigned: boolean | undefined;
	let onlyExisting = false;
	let compareNote = '';
	let toIoList = !!vscode.workspace.workspaceFolders?.length;
	let step = 1;
	let error: string | undefined;

	for (;;) {
		// --- 1. Excel wählen ------------------------------------------------------------
		if (step === 1) {
			const r = await w.step(
				page({
					progress: [1, TOTAL],
					title: 'Signal-Excel wählen',
					intro:
						'Die E/A-Kommentare (Signalnamen) aus der Excel-Tabelle werden in die E/A-Konfiguration des Roboters (<code>DIOCFGSV.IO</code>) übernommen. ' +
						'Erwartet werden Blätter, deren erste Kopfzelle der Signaltyp ist (DI, DO, GI, GO …), z. B. <b>PlcToRob</b>, <b>RobToPlc</b>, <b>GI</b>, <b>GO</b> aus „Fanuc IO-Mapping“.',
					error,
					content:
						(excel ? card('📗', path.basename(excel), esc(path.dirname(excel)), 'use', undefined, 'compact') : '') +
						card('📂', excel ? 'Andere Excel-Datei wählen …' : 'Excel-Datei wählen …', '.xls oder .xlsx', 'browse', undefined, 'compact'),
					buttons: cancelButton()
				})
			);
			error = undefined;
			if (r.act === 'cancel') {
				return w.close();
			}
			if (r.act === 'browse') {
				const picked = await vscode.window.showOpenDialog({
					canSelectMany: false,
					openLabel: 'Excel verwenden',
					filters: { 'Excel-Tabellen': ['xls', 'xlsx', 'XLS', 'XLSX'] }
				});
				if (!picked?.[0]) {
					continue;
				}
				excel = picked[0].fsPath;
			}
			if (!excel) {
				continue;
			}
			w.busy(`${path.basename(excel)} wird gelesen …`);
			try {
				report = readSignalWorkbook(readWorkbook(await fs.readFile(excel)), commentColumn);
			} catch (err) {
				error = `${esc(path.basename(excel))} konnte nicht gelesen werden: ${esc(err instanceof Error ? err.message : String(err))}`;
				continue;
			}
			await context.workspaceState.update('fanucLs.ioExcel.last', excel);
			types = [...new Set(report.items.filter((i) => i.text.trim()).map((i) => i.type))];
			step = 2;
			continue;
		}

		// --- 2. Inhalt prüfen, Typen wählen ------------------------------------------------
		if (step === 2) {
			const items = report!.items;
			const withText = (t: number) => items.filter((i) => i.type === t && i.text.trim()).length;
			const sourceTypes = [...new Set(items.map((i) => i.type))];
			const rows = report!.notes
				.map((n) => `<tr><td>${esc(n.source)}</td><td>${esc(n.type ?? '')}</td><td>${n.rows !== undefined ? n.rows : ''}</td><td>${n.type && n.type in PORT_TYPES ? withText(PORT_TYPES[n.type]) : ''}</td><td>${n.skipped ? '⚠️ ' + esc(n.skipped) : ''}</td></tr>`)
				.join('');
			const r = await w.step(
				page({
					progress: [2, TOTAL],
					title: 'Was soll übernommen werden?',
					intro: `Gelesen aus <b>${esc(path.basename(excel!))}</b>:`,
					error,
					content:
						`<table><tr><th>Blatt</th><th>Typ</th><th>Zeilen</th><th>mit Signalname</th><th></th></tr>${rows}</table>` +
						(sourceTypes.length
							? '<h2>Signaltypen übernehmen</h2>' +
								sourceTypes
									.map((t) => checkCard('types', String(t), PORT_NAMES[t], `${withText(t)} Signalname(n)`, types.includes(t)))
									.join('')
							: message('warn', 'Keine Blätter mit Signaltyp in der ersten Kopfzelle gefunden.')) +
						field('Spalte mit dem Signalnamen', 'column', commentColumn, {
							hint: 'Überschrift der Spalte, deren Text als Kommentar übernommen wird (Groß-/Kleinschreibung und Leerzeichen egal).'
						}),
					buttons: backButton() + button('🔄 Neu einlesen', 'reread') + button('Weiter →', 'next', { primary: true }) + cancelButton()
				})
			);
			error = undefined;
			if (r.act === 'cancel') {
				return w.close();
			}
			types = list(r.values.types).map(Number);
			const col = str(r.values.column) || 'Signal Name';
			if (r.act === 'back') {
				step = 1;
				continue;
			}
			if (r.act === 'reread' || col !== commentColumn) {
				commentColumn = col;
				w.busy('Wird neu eingelesen …');
				report = readSignalWorkbook(readWorkbook(await fs.readFile(excel!)), commentColumn);
				types = [...new Set(report.items.filter((i) => i.text.trim()).map((i) => i.type))];
				continue;
			}
			if (types.length === 0) {
				error = 'Bitte mindestens einen Signaltyp auswählen.';
				continue;
			}
			step = 3;
			continue;
		}

		// --- 3. Vorlage (DIOCFGSV.IO des Zielroboters) ----------------------------------------
		if (step === 3) {
			const robots = getControllers();
			const r = await w.step(
				page({
					progress: [3, TOTAL],
					title: 'Vorlage: E/A-Konfiguration des Roboters',
					intro:
						'Die neue Datei entsteht aus der aktuellen <code>DIOCFGSV.IO</code> <b>des Roboters, für den sie bestimmt ist</b>. ' +
						'Zuordnungen (Rack, Slot, Startpunkt) werden unverändert übernommen, nur die Kommentare ändern sich.',
					error,
					content:
						(template ? message('ok', `Gewählt: <b>${esc(template.label)}</b>`) : '') +
						robots.map((c, i) => card('🤖', `Vom Roboter ${c.name} holen`, `md:DIOCFGSV.IO · ${esc(c.host)}`, 'robot', String(i))).join('') +
						(robots.length ? '' : card('🤖', 'Roboter einrichten', 'Dann lässt sich die Vorlage direkt vom Roboter holen', 'setup', undefined, 'compact')) +
						card('📂', 'Datei aus einer Sicherung wählen …', 'DIOCFGSV.IO aus dem Backup des Zielroboters', 'file', undefined, 'compact'),
					buttons: backButton() + (template ? button('Weiter →', 'next', { primary: true }) : '') + cancelButton()
				})
			);
			error = undefined;
			if (r.act === 'cancel') {
				return w.close();
			}
			if (r.act === 'back') {
				step = 2;
				continue;
			}
			if (r.act === 'next' && template) {
				step = 4;
				continue;
			}
			if (r.act === 'setup') {
				await vscode.commands.executeCommand('fanucLs.welder.setup');
				continue;
			}
			try {
				if (r.act === 'robot') {
					const c = robots[Number(r.arg)];
					w.busy(`DIOCFGSV.IO wird von ${c.name} geholt …`);
					const tmp = path.join(os.tmpdir(), 'fanuc-ls', 'io', `${c.name.replace(/[^\w.-]+/g, '_')}_DIOCFGSV.IO`);
					await fs.mkdir(path.dirname(tmp), { recursive: true });
					await ftp.downloadToFile(c, api.secrets, 'md:DIOCFGSV.IO', tmp);
					const buf = await fs.readFile(tmp);
					DioCfg.parse(buf);
					// Original zusätzlich als Sicherung ablegen
					const base = await api.resolveDownloadDir();
					if (base) {
						const d = new Date();
						const p2 = (n: number) => String(n).padStart(2, '0');
						const dir = path.join(base, 'Sicherungen', c.name.replace(/[^\p{L}\p{N}_. ()-]+/gu, '_'), 'E-A-Konfiguration');
						await fs.mkdir(dir, { recursive: true });
						await fs.writeFile(path.join(dir, `DIOCFGSV_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}.IO`), buf);
					}
					template = { buf, label: `${c.name} (md:DIOCFGSV.IO, Original gesichert)`, controller: c };
					step = 4;
				} else if (r.act === 'file') {
					const picked = await vscode.window.showOpenDialog({
						canSelectMany: false,
						openLabel: 'Als Vorlage verwenden',
						filters: { 'E/A-Konfiguration': ['io', 'IO'] }
					});
					if (!picked?.[0]) {
						continue;
					}
					const buf = await fs.readFile(picked[0].fsPath);
					DioCfg.parse(buf);
					template = { buf, label: picked[0].fsPath, file: picked[0].fsPath };
					step = 4;
				}
			} catch (err) {
				error =
					r.act === 'robot' && !(err instanceof Error && /DIOCFGSV/.test(err.message))
						? ftpErrorText(err)
						: esc(err instanceof Error ? err.message : String(err));
			}
			continue;
		}

		// --- 4. Optionen und Vorschau -------------------------------------------------------
		const items = report!.items;
		let result: BuildResult;
		try {
			if (onlyAssigned === undefined) {
				// Standard: nur zugeordnete Signale, sobald die Vorlage Signale der Excel nicht kennt
				onlyAssigned = buildDioCfg(template!.buf, items, { replace, types }).unassigned.length > 0;
			}
			result = buildDioCfg(template!.buf, items, { replace, types, onlyAssigned, onlyExisting });
		} catch (err) {
			error = esc(err instanceof Error ? err.message : String(err));
			step = 3;
			continue;
		}
		if (step === 4) {
			const cfg = DioCfg.parse(template!.buf);
			const label = (c: { type: number; no: number }) => portLabel(c.type, c.no);
			const perTypeRows = types
				.map((t) => {
					const n = (arr: { type: number }[]) => arr.filter((c) => c.type === t).length;
					return `<tr><td><b>${PORT_NAMES[t]}</b></td><td>${n(result.added)}</td><td>${n(result.changed)}</td><td>${n(result.removed)}</td><td>${result.perType.get(t) ?? 0}</td></tr>`;
				})
				.join('');
			const sample = [
				...result.changed.slice(0, 15).map((c) => `<tr><td>${label(c)}</td><td>${esc(c.before)}</td><td class="new">${esc(c.after)}</td></tr>`),
				...result.added.slice(0, 15).map((c) => `<tr><td>${label(c)}</td><td><i>neu</i></td><td class="new">${esc(c.after)}</td></tr>`),
				...result.removed.slice(0, 10).map((c) => `<tr><td>${label(c)}</td><td>${esc(c.before)}</td><td><i>entfernt</i></td></tr>`)
			].join('');
			const asgText = (t: number) =>
				cfg
					.assignments()
					.filter((a) => a.type === t)
					.map((a) => `${a.start}–${a.start + a.count - 1}`)
					.join(', ') || 'keine';
			const unassignedTypes = [...new Set(result.unassigned.map((i) => i.type))];
			const named = report!.items.filter((i) => types.includes(i.type) && i.text.trim()).length;
			const mismatch = result.unassigned.length
				? message(
						result.unassigned.length >= named / 2 ? 'error' : 'warn',
						`<b>${result.unassigned.length} von ${named} Signalen sind in der Vorlage keiner Hardware zugeordnet</b>, z. B. ${result.unassigned
							.slice(0, 3)
							.map((i) => portLabel(i.type, i.no))
							.join(', ')}. Zugeordnet sind in der Vorlage: ${unassignedTypes.map((t) => `${PORT_NAMES[t]} ${asgText(t)}`).join('; ')}.<br>` +
							'<b>Stammt die Vorlage wirklich vom Zielroboter?</b> Eine <code>DIOCFGSV.IO</code> von einem anderen Roboter oder Softwarestand führt beim Laden zu Alarmen wie <b>VARS-004 / VARS-032</b> („Unknown variable name“) und würde dessen E/A-Zuordnungen überschreiben. Am sichersten: Vorlage direkt vom Zielroboter holen.'
					)
				: '';
			const robots = getControllers();
			const r = await w.step(
				page({
					progress: [4, TOTAL],
					title: 'Vorschau – bitte prüfen',
					intro: `Vorlage: <b>${esc(template!.label)}</b> · ${cfg.assignments().length} Zuordnungen bleiben unverändert.`,
					error,
					content:
						mismatch +
						compareNote +
						(template!.file && robots.length
							? '<h2>Vorlage mit dem Zielroboter abgleichen</h2>' +
								robots.map((c, i) => card('🔍', `Mit ${c.name} vergleichen`, 'Softwarestand, Variablen und Zuordnungen mit md:DIOCFGSV.IO des Roboters vergleichen', 'compare', String(i), 'compact')).join('')
							: '') +
						radioCard('mode', 'merge', 'Zusammenführen (empfohlen)', 'Kommentare aus der Excel ersetzen vorhandene; Signale ohne Namen in der Excel behalten ihren bisherigen Kommentar.', !replace) +
						radioCard('mode', 'replace', 'Ersetzen', 'Alle bisherigen Kommentare der gewählten Typen werden gelöscht, nur die Excel zählt.', replace) +
						checkCard('opt', 'assigned', 'Nur Signale übernehmen, die in der Vorlage zugeordnet sind', 'Kommentare für Signale ohne Hardware-Zuordnung in der Vorlage werden weggelassen.', !!onlyAssigned) +
						checkCard('opt', 'existing', 'Testdatei: nur vorhandene Kommentare ändern', 'Es kommen keine Einträge hinzu und keine fallen weg; die Felder behalten die Länge der Vorlage. Hilft beim Eingrenzen von Ladefehlern (VARS-032).', onlyExisting) +
						(result.skipped ? message('info', `${result.skipped} Signalname(n) werden wegen dieser Optionen nicht übernommen.`) : '') +
						button('Vorschau aktualisieren', 'refresh') +
						`<h2>Änderungen</h2><table><tr><th>Typ</th><th>neu</th><th>geändert</th><th>entfernt</th><th>gesamt</th></tr>${perTypeRows}</table>` +
						(result.truncated.length
							? message('warn', `${result.truncated.length} Signalname(n) länger als ${MAX_COMMENT} Zeichen werden gekürzt: ${result.truncated.slice(0, 8).map((t) => `${portLabel(t.type, t.no)} „${esc(t.text)}“`).join(', ')}${result.truncated.length > 8 ? ' …' : ''}`)
							: '') +
						(sample ? `<h2>Beispiele</h2><table><tr><th>Signal</th><th>bisher</th><th>neu</th></tr>${sample}</table>` : message('info', 'Keine Änderungen gegenüber der Vorlage.')) +
						(vscode.workspace.workspaceFolders?.length
							? checkCard('iolist', '1', 'Auch in die E/A-Liste dieser Arbeitsumgebung übernehmen', 'Dann zeigen Hover und Vervollständigung im Editor sofort die neuen Signalnamen.', toIoList)
							: ''),
					buttons: backButton() + button('💾 DIOCFGSV.IO erzeugen', 'build', { primary: true }) + cancelButton()
				})
			);
			error = undefined;
			if (r.act === 'cancel') {
				return w.close();
			}
			replace = str(r.values.mode) === 'replace';
			onlyAssigned = list(r.values.opt).includes('assigned');
			onlyExisting = list(r.values.opt).includes('existing');
			toIoList = list(r.values.iolist).length > 0;
			if (r.act === 'back') {
				step = 3;
				continue;
			}
			if (r.act === 'refresh') {
				continue;
			}
			if (r.act === 'compare') {
				const c = robots[Number(r.arg)];
				w.busy(`DIOCFGSV.IO von ${c.name} wird zum Vergleich geholt …`);
				try {
					const robotCfg = DioCfg.parse(await fetchRobotDio(api, c));
					const cmp = compareDioCfg(DioCfg.parse(template!.buf), robotCfg);
					compareNote =
						cmp.errors.length || cmp.warnings.length
							? message(
									cmp.errors.length ? 'error' : 'warn',
									`<b>Vergleich mit ${esc(c.name)}:</b><br>${[...cmp.errors, ...cmp.warnings].map(esc).join('<br>')}` +
										(cmp.errors.length ? '<br><b>Diese Vorlage passt nicht zum Roboter.</b> Bitte die Vorlage von diesem Roboter holen (Zurück).' : '')
								)
							: message('ok', `Vorlage passt zu ${esc(c.name)}: Softwarestand, Variablen und Zuordnungen stimmen überein.`);
				} catch (err) {
					compareNote = message('error', ftpErrorText(err));
				}
				continue;
			}
			// --- 5. speichern ---
			const base = (await api.resolveDownloadDir()) ?? path.dirname(excel!);
			const proposal = path.join(base, 'E-A-Konfiguration', template!.controller?.name.replace(/[^\p{L}\p{N}_. ()-]+/gu, '_') ?? 'neu', 'DIOCFGSV.IO');
			await fs.mkdir(path.dirname(proposal), { recursive: true });
			const target = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(proposal),
				filters: { 'E/A-Konfiguration': ['IO'] },
				saveLabel: 'Speichern',
				title: 'Neue DIOCFGSV.IO speichern'
			});
			if (!target) {
				continue;
			}
			if (template!.file && path.resolve(template!.file) === path.resolve(target.fsPath)) {
				error = 'Die Vorlage darf nicht überschrieben werden – bitte einen anderen Ordner wählen.';
				continue;
			}
			await fs.writeFile(target.fsPath, result.output);
			let ioListNote = '';
			if (toIoList) {
				const entries = [...result.comments]
					.map(([k, comment]) => {
						const [t, index] = k.split(':').map(Number);
						return { type: normalizeIoType(PORT_NAMES[t] ?? '')!, index, comment };
					})
					.filter((e) => e.type);
				const file = await store.saveImported(template!.controller?.name, `${path.basename(excel!)} → DIOCFGSV.IO`, entries);
				ioListNote = file ? `<br>E/A-Liste aktualisiert: <code>${esc(vscode.workspace.asRelativePath(file))}</code>` : '';
			}
			await done(w, api, target.fsPath, result, template!, ioListNote);
			return;
		}
	}
}

/** Hilfe bei Ladefehlern am Roboter. */
const TROUBLESHOOTING =
	'<details><summary><b>Alarme beim Laden (VARS-004, VARS-032, „Unknown variable name“)?</b></summary><ul>' +
	'<li><b>Vorlage vom falschen Roboter oder Softwarestand:</b> Die Datei kennt Variablen, die der Roboter nicht hat, oder umgekehrt. Vorlage direkt vom Zielroboter holen (Schritt 3) bzw. mit <i>Mit … vergleichen</i> prüfen.</li>' +
	'<li><b>Nicht im Controlled Start geladen:</b> Im normalen Betrieb lassen sich die Felder der E/A-Konfiguration nicht in der Länge ändern.</li>' +
	'<li><b>Eingrenzen:</b> eine Testdatei mit der Option <i>nur vorhandene Kommentare ändern</i> erzeugen. Lädt sie fehlerfrei, liegt es an der Anzahl der Einträge.</li>' +
	'<li>Den genauen Alarmtext mit <b>DETAIL</b> in der Alarmhistorie notieren (enthält meist den Variablennamen) und den Bericht <i>FANUC: DIOCFGSV.IO prüfen / vergleichen</i> erstellen.</li>' +
	'</ul></details>';

async function fetchRobotDio(api: FanucApi, c: ControllerConfig): Promise<Buffer> {
	const tmp = path.join(os.tmpdir(), 'fanuc-ls', 'io', `${c.name.replace(/[^\w.-]+/g, '_')}_DIOCFGSV_check.IO`);
	await fs.mkdir(path.dirname(tmp), { recursive: true });
	await ftp.downloadToFile(c, api.secrets, 'md:DIOCFGSV.IO', tmp);
	return fs.readFile(tmp);
}

async function done(w: Wizard, api: FanucApi, file: string, result: BuildResult, template: Template, ioListNote: string): Promise<void> {
	const robot = template.controller;
	w.onCommand = (cmd) => {
		if (cmd === 'reveal') {
			void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
		}
	};
	let note = '';
	for (;;) {
		// nur Wechselspeicher (USB, Speicherkarte), von dem im Controlled Start geladen wird
		const devices = robot ? devicesOf(robot).filter((d) => /^(ud\d*|ut\d*|mc):/i.test(d)) : [];
		const r = await w.step(
			page({
				progress: [5, TOTAL],
				title: 'DIOCFGSV.IO erzeugt',
				content:
					message('ok', `<b>${result.comments.size} Kommentare</b> (neu ${result.added.length}, geändert ${result.changed.length}, entfernt ${result.removed.length}) gespeichert und geprüft:<br><code>${esc(file)}</code>${ioListNote}`) +
					note +
					'<h2>So kommt die Datei auf den Roboter</h2>' +
					'<ol>' +
					'<li>Vorher eine <b>vollständige Sicherung</b> des Roboters machen.</li>' +
					`<li>Datei auf einen USB-Stick kopieren${devices.length ? ' oder unten direkt auf ein Gerät des Roboters übertragen' : ''}.</li>` +
					'<li>Steuerung im <b>Controlled Start</b> starten.</li>' +
					'<li><b>MENU → FILE</b>, Gerät wählen (z. B. UD1: für USB), <b>DIOCFGSV.IO</b> auswählen und <b>LOAD</b>.</li>' +
					'<li>Kaltstart, danach unter <b>MENU → E/A</b> die Kommentare prüfen.</li>' +
					'</ol>' +
					message('warn', 'Die Datei enthält auch die E/A-Zuordnungen der Vorlage. Nur in den Roboter laden, von dem die Vorlage stammt. Am echten Roboter ist dieser Ablauf noch nicht erprobt – zuerst an einer Testzelle oder in ROBOGUIDE ausprobieren.') +
					TROUBLESHOOTING +
					(devices.length
						? `<h2>Auf ${esc(robot!.name)} übertragen (optional)</h2>` + devices.map((d) => card('⬆️', `Nach ${d} kopieren`, `${esc(d)}DIOCFGSV.IO – danach im Controlled Start von dort laden`, 'upload', d, 'compact')).join('')
						: ''),
				buttons: button('📂 Ordner öffnen', 'cmd:reveal') + button('Fertig', 'done', { primary: true })
			})
		);
		if (r.act !== 'upload' || !robot || !r.arg) {
			return w.close();
		}
		w.busy(`DIOCFGSV.IO wird mit ${robot.name} abgeglichen …`);
		try {
			const cmp = compareDioCfg(DioCfg.parse(await fs.readFile(file)), DioCfg.parse(await fetchRobotDio(api, robot)));
			if (cmp.errors.length) {
				note = message('error', `<b>Nicht kopiert:</b> Die Datei passt nicht zur E/A-Konfiguration auf ${esc(robot.name)}.<br>${cmp.errors.map(esc).join('<br>')}`);
				continue;
			}
			w.busy(`DIOCFGSV.IO wird nach ${r.arg} auf ${robot.name} kopiert …`);
			await ftp.uploadFile(robot, api.secrets, file, ftp.joinRemote(r.arg, 'DIOCFGSV.IO'));
			note = message('ok', `Auf ${esc(robot.name)} unter <code>${esc(r.arg)}DIOCFGSV.IO</code> abgelegt.`);
		} catch (err) {
			note = message('error', ftpErrorText(err));
		}
	}
}

/** Bericht über eine DIOCFGSV.IO, optional verglichen mit einer zweiten Datei oder der auf einem Roboter. */
async function inspect(api: FanucApi): Promise<void> {
	const pickSource = async (placeHolder: string, allowNone: boolean): Promise<{ name: string; buf: Buffer } | undefined | null> => {
		const robots = getControllers();
		const items = [
			{ label: '$(file) Datei wählen …', value: 'file' },
			...robots.map((c, i) => ({ label: `$(server-environment) ${c.name}`, description: 'md:DIOCFGSV.IO vom Roboter', value: String(i) })),
			...(allowNone ? [{ label: '$(close) Nicht vergleichen', value: 'none' }] : [])
		];
		const picked = await vscode.window.showQuickPick(items, { placeHolder });
		if (!picked) {
			return undefined;
		}
		if (picked.value === 'none') {
			return null;
		}
		if (picked.value === 'file') {
			const f = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'E/A-Konfiguration': ['io', 'IO'] } });
			return f?.[0] ? { name: path.basename(f[0].fsPath), buf: await fs.readFile(f[0].fsPath) } : undefined;
		}
		const c = robots[Number(picked.value)];
		const buf = await api.withProgress(`DIOCFGSV.IO von ${c.name}`, () => fetchRobotDio(api, c));
		return { name: `${c.name} (md:DIOCFGSV.IO)`, buf };
	};
	const first = await pickSource('Welche DIOCFGSV.IO prüfen?', false);
	if (!first) {
		return;
	}
	const second = await pickSource('Vergleichen mit … (z. B. dem Zielroboter)', true);
	if (second === undefined) {
		return;
	}
	const md = dioReport(first.name, DioCfg.parse(first.buf), second?.name, second ? DioCfg.parse(second.buf) : undefined);
	const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
	await vscode.window.showTextDocument(doc, { preview: false });
	await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri);
}
