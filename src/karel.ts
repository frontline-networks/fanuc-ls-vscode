import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { KarelSymbol, hasConfigArg, ktransCommandLine, parseKarel, parseRobotIni, robotIniSearchDirs, usesSystemVariables } from './karelCore';

const SELECTOR: vscode.DocumentSelector = { language: 'fanuc-karel' };

const KINDS: Record<KarelSymbol['kind'], vscode.SymbolKind> = {
	program: vscode.SymbolKind.Module,
	routine: vscode.SymbolKind.Function,
	external: vscode.SymbolKind.Interface,
	const: vscode.SymbolKind.Constant,
	var: vscode.SymbolKind.Variable,
	type: vscode.SymbolKind.Struct
};

function toSymbol(doc: vscode.TextDocument, s: KarelSymbol): vscode.DocumentSymbol {
	const end = Math.min(s.endLine, doc.lineCount - 1);
	const range = new vscode.Range(s.line, 0, end, doc.lineAt(end).text.length);
	const selection = new vscode.Range(s.line, s.nameStart, s.line, s.nameStart + s.name.length);
	const sym = new vscode.DocumentSymbol(s.name, s.detail, KINDS[s.kind], range, selection);
	sym.children = s.children.map((c) => toSymbol(doc, c));
	return sym;
}

export function registerKarelFeatures(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
			provideDocumentSymbols: (doc) => parseKarel(doc.getText()).map((s) => toSymbol(doc, s))
		}),
		vscode.commands.registerCommand('fanucLs.karel.compile', async (uri?: vscode.Uri) => {
			const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
			if (!doc || doc.languageId !== 'fanuc-karel' || doc.uri.scheme !== 'file') {
				vscode.window.showWarningMessage('Bitte eine gespeicherte KAREL-Datei (.kl) öffnen.');
				return;
			}
			if (doc.isDirty) {
				await doc.save();
			}
			const cfg = vscode.workspace.getConfiguration('fanucLs', doc.uri);
			const ktrans = cfg.get<string>('karel.ktransPath', '').trim();
			if (!ktrans) {
				const action = await vscode.window.showWarningMessage(
					'Zum Kompilieren wird ktrans.exe aus ROBOGUIDE benötigt (nur Windows). Bitte den Pfad in "fanucLs.karel.ktransPath" eintragen.',
					'Einstellung öffnen'
				);
				if (action) {
					await vscode.commands.executeCommand('workbench.action.openSettings', 'fanucLs.karel');
				}
				return;
			}
			const file = doc.uri.fsPath;
			const out = file.replace(/\.kl$/i, '.pc');
			const args = cfg.get<string>('karel.ktransArgs', '').trim();
			let robotIni: string | undefined;
			if (!hasConfigArg(args)) {
				robotIni = await findRobotIni(doc.uri);
				if (!robotIni && usesSystemVariables(doc.getText()) && !context.workspaceState.get<boolean>('karel.noRobotIni')) {
					const choice = await vscode.window.showWarningMessage(
						'Keine robot.ini gefunden. Ohne sie übersetzt ktrans mit den Grund-Support-Dateien und kennt Systemvariablen von Optionen nicht ' +
							'(z. B. ArcTool: $AWSCFG, $AWEPOR → „Id must be defined before this use“). ' +
							'Die robot.ini liegt im Roboterordner einer ROBOGUIDE-Zelle (…\\My Workcells\\<Zelle>\\Robot_1) oder wird mit setrobot.exe erzeugt.',
						'robot.ini wählen',
						'Ohne robot.ini kompilieren',
						'Nicht mehr fragen'
					);
					if (choice === 'robot.ini wählen') {
						robotIni = await selectRobotIni(doc.uri);
						if (!robotIni) {
							return;
						}
					} else if (choice === 'Nicht mehr fragen') {
						await context.workspaceState.update('karel.noRobotIni', true);
					} else if (!choice) {
						return;
					}
				}
			}
			const terminal =
				vscode.window.terminals.find((t) => t.name === 'FANUC KAREL' && String((t.creationOptions as vscode.TerminalOptions).cwd ?? '') === path.dirname(file)) ??
				vscode.window.createTerminal({ name: 'FANUC KAREL', cwd: path.dirname(file) });
			terminal.show(true);
			terminal.sendText(ktransCommandLine(ktrans, path.basename(file), path.basename(out), args, robotIni, process.platform === 'win32'));
		}),
		vscode.commands.registerCommand('fanucLs.karel.selectRobotIni', async () => {
			const uri = vscode.window.activeTextEditor?.document.uri;
			const ini = await selectRobotIni(uri);
			if (ini) {
				const info = parseRobotIni(await fs.readFile(ini, 'latin1'));
				vscode.window.showInformationMessage(`ktrans verwendet jetzt ${ini}${info?.version ? ` (Softwarestand ${info.version})` : ''}.`);
			}
		})
	);
}

/** robot.ini: Einstellung fanucLs.karel.robotIni, sonst robot.ini neben der .kl-Datei oder in einem Elternordner im Arbeitsbereich. */
async function findRobotIni(uri: vscode.Uri): Promise<string | undefined> {
	const setting = vscode.workspace.getConfiguration('fanucLs', uri).get<string>('karel.robotIni', '').trim();
	if (setting) {
		const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? '';
		const resolved = setting.replace(/\$\{workspaceFolder\}/g, folder);
		const full = path.isAbsolute(resolved) ? resolved : path.join(folder || path.dirname(uri.fsPath), resolved);
		if (await exists(full)) {
			return full;
		}
		vscode.window.showWarningMessage(`fanucLs.karel.robotIni: ${full} nicht gefunden.`);
	}
	const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
	for (const dir of robotIniSearchDirs(path.dirname(uri.fsPath), roots)) {
		try {
			const hit = (await fs.readdir(dir)).find((f) => f.toLowerCase() === 'robot.ini');
			if (hit) {
				return path.join(dir, hit);
			}
		} catch {
			// Ordner nicht lesbar
		}
	}
	return undefined;
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/** robot.ini auswählen (Start in "Dokumente\\My Workcells") und in den Einstellungen speichern. */
async function selectRobotIni(uri: vscode.Uri | undefined): Promise<string | undefined> {
	const workcells = [path.join(os.homedir(), 'Documents', 'My Workcells'), path.join(os.homedir(), 'Dokumente', 'My Workcells')];
	let start: string | undefined;
	for (const w of workcells) {
		if (await exists(w)) {
			start = w;
			break;
		}
	}
	const picked = await vscode.window.showOpenDialog({
		title: 'robot.ini für ktrans wählen (Roboterordner der ROBOGUIDE-Zelle, z. B. My Workcells\\<Zelle>\\Robot_1)',
		openLabel: 'robot.ini verwenden',
		canSelectMany: false,
		filters: { 'robot.ini': ['ini'] },
		defaultUri: start ? vscode.Uri.file(start) : undefined
	});
	const file = picked?.[0]?.fsPath;
	if (!file) {
		return undefined;
	}
	const info = parseRobotIni(await fs.readFile(file, 'latin1'));
	if (!info) {
		const go = await vscode.window.showWarningMessage(
			`${path.basename(file)} sieht nicht wie eine robot.ini aus (Abschnitt [WinOLPC_Util] fehlt). Trotzdem verwenden?`,
			'Verwenden'
		);
		if (!go) {
			return undefined;
		}
	}
	const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	await vscode.workspace.getConfiguration('fanucLs', uri).update('karel.robotIni', file, target);
	return file;
}
