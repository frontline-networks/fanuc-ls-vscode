import * as vscode from 'vscode';
import { getControllers } from './config';
import * as ftp from './ftp';

/**
 * Prüft regelmäßig, ob die Roboter per FTP erreichbar sind (#19) - nur solange eine
 * Ansicht sichtbar ist, die den Status anzeigt. Jede andere FTP-Aktion aktualisiert
 * den Status ebenfalls; kürzlich geprüfte Roboter werden übersprungen.
 */
export function startStatusChecks(secrets: vscode.SecretStorage, isVisible: () => boolean): vscode.Disposable {
	const pending = new Set<string>();
	const tick = () => {
		const seconds = vscode.workspace.getConfiguration('fanucLs').get<number>('ftp.statusInterval', 60);
		if (!seconds || seconds <= 0 || !isVisible()) {
			return;
		}
		for (const c of getControllers()) {
			const status = ftp.statusOf(c);
			if (pending.has(c.name) || (status && Date.now() - status.checkedAt.getTime() < seconds * 1000)) {
				continue;
			}
			pending.add(c.name);
			ftp.ping(c, secrets)
				.catch(() => undefined)
				.finally(() => pending.delete(c.name));
		}
	};
	const timer = setInterval(tick, 5000);
	setTimeout(tick, 1500);
	return { dispose: () => clearInterval(timer) };
}
