import * as vscode from 'vscode';
import * as path from 'path';
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
							'Die robot.ini erzeugt setrobot.exe (WinOLPC): ROBOGUIDE-Roboter mit denselben Optionen wählen, die Datei entsteht neben der .kl-Datei.',
						'Mit setrobot erzeugen',
						'robot.ini wählen',
						'Ohne robot.ini kompilieren',
						'Nicht mehr fragen'
					);
					if (choice === 'Mit setrobot erzeugen') {
						await runSetrobot(ktrans, path.dirname(file));
						return;
					} else if (choice === 'robot.ini wählen') {
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
			const how = await vscode.window.showQuickPick(
				[
					{ label: '$(add) Mit setrobot.exe erzeugen', description: 'ROBOGUIDE-Roboter wählen, robot.ini entsteht im Ordner', id: 'setrobot' },
					{ label: '$(file) Vorhandene robot.ini wählen', id: 'pick' }
				],
				{ title: 'robot.ini für ktrans' }
			);
			if (!how) {
				return;
			}
			if (how.id === 'setrobot') {
				const ktrans = vscode.workspace.getConfiguration('fanucLs', uri).get<string>('karel.ktransPath', '').trim();
				const dir =
					uri?.scheme === 'file' && /\.kl$/i.test(uri.fsPath)
						? path.dirname(uri.fsPath)
						: (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
							(await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'robot.ini hier erzeugen' }))?.[0]?.fsPath);
				if (dir) {
					await runSetrobot(ktrans, dir);
				}
				return;
			}
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

/** robot.ini auswählen und in den Einstellungen speichern. */
async function selectRobotIni(uri: vscode.Uri | undefined): Promise<string | undefined> {
	const picked = await vscode.window.showOpenDialog({
		title: 'robot.ini für ktrans wählen (erzeugt mit setrobot.exe)',
		openLabel: 'robot.ini verwenden',
		canSelectMany: false,
		filters: { 'robot.ini': ['ini'] },
		defaultUri: uri?.scheme === 'file' ? vscode.Uri.file(path.dirname(uri.fsPath)) : undefined
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

/**
 * setrobot.exe (neben ktrans.exe in WinOLPC\\bin) im Zielordner starten: Der Anwender wählt einen
 * ROBOGUIDE-Roboter, setrobot schreibt die robot.ini in den aktuellen Ordner.
 */
async function runSetrobot(ktrans: string, dir: string): Promise<void> {
	const setrobot = ktrans ? path.join(path.dirname(ktrans), 'setrobot.exe') : '';
	if (!setrobot || !(await exists(setrobot))) {
		vscode.window.showWarningMessage(
			`setrobot.exe nicht gefunden${setrobot ? ` (${setrobot})` : ''}. Es liegt normalerweise neben ktrans.exe in „…\\FANUC\\WinOLPC\\bin“. ` +
				`Dort starten, den ROBOGUIDE-Roboter wählen und die erzeugte robot.ini nach ${dir} kopieren.`
		);
		return;
	}
	const terminal =
		vscode.window.terminals.find((t) => t.name === 'FANUC KAREL' && String((t.creationOptions as vscode.TerminalOptions).cwd ?? '') === dir) ??
		vscode.window.createTerminal({ name: 'FANUC KAREL', cwd: dir });
	terminal.show(true);
	terminal.sendText(`${process.platform === 'win32' && /\s/.test(setrobot) ? '& ' : ''}${/\s/.test(setrobot) ? `"${setrobot}"` : setrobot}`);
	vscode.window.showInformationMessage(
		`setrobot.exe läuft: im Fenster den ROBOGUIDE-Roboter mit denselben Optionen (z. B. ArcTool) und demselben Softwarestand wählen. ` +
			`Die robot.ini entsteht in ${dir}; danach einfach erneut kompilieren – sie wird automatisch verwendet.`
	);
}
