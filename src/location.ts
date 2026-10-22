import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { findCloneRoot } from './cloneCore';

/** Wo liegt eine Datei: auf dem Roboter (Ansicht/Vergleich) oder am PC (Klon/Arbeitskopie)? (#23) */
export interface FileLocation {
	online: boolean;
	/** kurze Beschriftung, z. B. "Roboter R1 · Ansicht" */
	label: string;
	/** Erklärung für Tooltips */
	detail: string;
}

type OriginLookup = (fsPath: string) => Promise<{ controller: string; remotePath: string } | undefined>;

export function viewRoot(): string {
	return path.join(os.tmpdir(), 'fanuc-ls');
}

export async function locate(fsPath: string, originOf: OriginLookup): Promise<FileLocation> {
	const root = viewRoot() + path.sep;
	const origin = await originOf(fsPath);
	if (fsPath.startsWith(path.join(root, 'compare') + path.sep) || fsPath.startsWith(path.join(root, 'clone-check') + path.sep)) {
		return {
			online: true,
			label: 'Stand auf dem Roboter (Vergleich)',
			detail: 'Frisch vom Roboter geladener Stand, nur zum Vergleichen. Änderungen hier werden nicht übertragen.'
		};
	}
	if (fsPath.startsWith(root)) {
		const where = origin ? `${origin.controller} · ${origin.remotePath}` : 'Roboter';
		return {
			online: true,
			label: `Roboter ${where} (Ansicht)`,
			detail:
				`Ansicht der Datei auf dem Roboter ${where}, geladen beim Öffnen. ` +
				'„Aktualisieren“ lädt sie neu. Änderungen landen erst mit „Hochladen“ auf dem Roboter.'
		};
	}
	const clone = await findCloneRoot(fsPath);
	if (clone) {
		return {
			online: false,
			label: `Klon von ${clone.manifest.controller} (offline)`,
			detail:
				`Offline-Kopie im Klon von ${clone.manifest.controller} (Ordner ${path.basename(clone.root)}). ` +
				'Änderungen bleiben am PC, bis sie mit „Klon: Änderungen übertragen“ auf den Roboter geladen werden.'
		};
	}
	if (origin) {
		return {
			online: false,
			label: `PC-Kopie von ${origin.controller} (offline)`,
			detail: `Offline-Kopie am PC, stammt von ${origin.controller} (${origin.remotePath}). Änderungen bleiben am PC, bis sie hochgeladen werden.`
		};
	}
	return { online: false, label: 'PC (offline)', detail: 'Datei am PC ohne bekannte Herkunft von einem Roboter.' };
}

const LANGS = ['fanuc-ls', 'fanuc-karel', 'fanuc-dt'];

/** Statusleisten-Eintrag mit der Herkunft der aktiven Datei. */
export function registerLocationStatus(context: vscode.ExtensionContext, originOf: OriginLookup): void {
	const item = vscode.window.createStatusBarItem('fanucLs.location', vscode.StatusBarAlignment.Left, 50);
	item.name = 'FANUC: Herkunft der Datei';
	const update = async () => {
		const doc = vscode.window.activeTextEditor?.document;
		if (!doc || doc.uri.scheme !== 'file' || !LANGS.includes(doc.languageId)) {
			item.hide();
			return;
		}
		const loc = await locate(doc.uri.fsPath, originOf);
		if (vscode.window.activeTextEditor?.document !== doc) {
			return;
		}
		item.text = `${loc.online ? '$(cloud)' : '$(device-desktop)'} ${loc.label}`;
		item.tooltip = new vscode.MarkdownString(`**${loc.online ? '🤖 Online – Roboter' : '💻 Offline – PC'}**\n\n${loc.detail}`);
		item.backgroundColor = loc.online ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
		item.show();
	};
	context.subscriptions.push(
		item,
		vscode.window.onDidChangeActiveTextEditor(() => void update()),
		vscode.workspace.onDidSaveTextDocument(() => void update())
	);
	void update();
}
