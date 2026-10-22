import * as vscode from 'vscode';
import { ControllerConfig, devicesOf, getControllers } from './config';
import { joinRemote, list, onDidChangeStatus, RemoteEntry, statusOf } from './ftp';
import { FILE_TYPE_GROUPS, FileFilter, NO_FILTER, describeFilter, isActive, matchesFileFilter } from './treeFilter';

export type FanucNode = ControllerNode | DeviceNode | DirNode | FileNode | ErrorNode;

export class ControllerNode extends vscode.TreeItem {
	readonly kind = 'controller';
	constructor(public readonly controller: ControllerConfig) {
		super(controller.name, vscode.TreeItemCollapsibleState.Collapsed);
		const status = statusOf(controller);
		const host = `${controller.host}${controller.port && controller.port !== 21 ? ':' + controller.port : ''}`;
		this.description = status ? `${status.online ? '● online' : '○ nicht erreichbar'} · ${host}` : host;
		const time = status ? status.checkedAt.toLocaleTimeString('de-DE') : '';
		this.tooltip = new vscode.MarkdownString(
			`**${controller.name}** – ${
				status ? (status.online ? `🟢 online (zuletzt verbunden ${time})` : `🔴 nicht erreichbar (geprüft ${time})`) : '⚪ Status noch unbekannt'
			}\n\n- Host: \`${controller.host}\`\n- Port: \`${controller.port ?? 21}\`\n- Benutzer: \`${controller.user || 'anonymous'}\`` +
				(status && !status.online && status.message ? `\n\nFehler: ${status.message}` : '') +
				'\n\nDie Dateien unter diesem Eintrag liegen **auf dem Roboter (online)**.'
		);
		this.iconPath = new vscode.ThemeIcon(
			'server-environment',
			status ? new vscode.ThemeColor(status.online ? 'testing.iconPassed' : 'testing.iconFailed') : undefined
		);
		this.contextValue = 'controller';
	}
}

export class DeviceNode extends vscode.TreeItem {
	readonly kind = 'device';
	constructor(public readonly controller: ControllerConfig, public readonly device: string) {
		super(device, vscode.TreeItemCollapsibleState.Collapsed);
		this.iconPath = new vscode.ThemeIcon('database');
		this.contextValue = 'device';
		this.tooltip = `${controller.name} - ${device}`;
	}
	get remotePath(): string {
		return this.device;
	}
}

export class DirNode extends vscode.TreeItem {
	readonly kind = 'dir';
	constructor(
		public readonly controller: ControllerConfig,
		public readonly remotePath: string,
		name: string
	) {
		super(name, vscode.TreeItemCollapsibleState.Collapsed);
		this.iconPath = vscode.ThemeIcon.Folder;
		this.contextValue = 'dir';
	}
}

export class FileNode extends vscode.TreeItem {
	readonly kind = 'file';
	constructor(
		public readonly controller: ControllerConfig,
		public readonly remotePath: string,
		public readonly entry: RemoteEntry
	) {
		super(entry.name, vscode.TreeItemCollapsibleState.None);
		this.description = formatSize(entry.size) + (entry.modified ? `  ${formatDate(entry.modified)}` : '');
		this.contextValue = 'file';
		this.resourceUri = vscode.Uri.parse(`fanuc-remote:/${entry.name}`);
		this.iconPath = new vscode.ThemeIcon(iconFor(entry.name));
		this.tooltip = `${controller.name}  ${remotePath}`;
		this.command = {
			command: 'fanucLs.openRemoteFile',
			title: 'Öffnen',
			arguments: [this]
		};
	}
}

export class ErrorNode extends vscode.TreeItem {
	readonly kind = 'error';
	constructor(message: string) {
		super(message, vscode.TreeItemCollapsibleState.None);
		this.iconPath = new vscode.ThemeIcon('warning');
		this.contextValue = 'error';
		this.tooltip = message;
	}
}

function iconFor(name: string): string {
	const lower = name.toLowerCase();
	if (lower.endsWith('.ls')) {
		return 'file-code';
	}
	if (lower.endsWith('.kl')) {
		return 'file-code';
	}
	if (lower.endsWith('.tp') || lower.endsWith('.pc')) {
		return 'file-binary';
	}
	if (lower.endsWith('.va') || lower.endsWith('.sv') || lower.endsWith('.vr')) {
		return 'settings-gear';
	}
	if (lower.endsWith('.dt') || lower.endsWith('.dg')) {
		return 'output';
	}
	return 'file';
}

function formatDate(s: string): string {
	const d = new Date(s);
	return isNaN(d.getTime()) ? s : d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function formatSize(bytes: number): string {
	if (!bytes || bytes < 0) {
		return '';
	}
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} kB`;
	}
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class ControllerTreeProvider implements vscode.TreeDataProvider<FanucNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<FanucNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly cache = new Map<string, FanucNode[]>();
	private filter: FileFilter = NO_FILTER;

	getFilter(): FileFilter {
		return this.filter;
	}

	/** Filter setzen (#20): wirkt auf Dateien, Ordner bleiben sichtbar. Dateilisten bleiben im Cache. */
	setFilter(f: FileFilter): void {
		this.filter = f;
		this._onDidChangeTreeData.fire(undefined);
	}

	constructor(private readonly secrets: vscode.SecretStorage) {
		// Online-Status geändert: nur die Controller-Einträge neu zeichnen, Dateilisten bleiben im Cache
		onDidChangeStatus(() => this._onDidChangeTreeData.fire(undefined));
	}

	refresh(node?: FanucNode): void {
		if (node) {
			this.cache.delete(cacheKey(node));
		} else {
			this.cache.clear();
		}
		this._onDidChangeTreeData.fire(node);
	}

	getTreeItem(element: FanucNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: FanucNode): Promise<FanucNode[]> {
		if (!element) {
			return getControllers().map((c) => new ControllerNode(c));
		}
		if (element instanceof FileNode || element instanceof ErrorNode) {
			return [];
		}
		if (element instanceof ControllerNode) {
			return devicesOf(element.controller).map((d) => new DeviceNode(element.controller, d));
		}

		const key = cacheKey(element);
		const cached = this.cache.get(key) ?? (await this.load(element));
		if (!isActive(this.filter)) {
			return cached;
		}
		const visible = cached.filter((n) => !(n instanceof FileNode) || matchesFileFilter(n.entry.name, this.filter));
		const hidden = cached.length - visible.length;
		return hidden && visible.length === 0 ? [new ErrorNode(`(${hidden} Datei(en) durch Filter ausgeblendet)`)] : visible;
	}

	private async load(element: DeviceNode | DirNode): Promise<FanucNode[]> {
		const key = cacheKey(element);

		const controller = element.controller;
		const remotePath = element instanceof DeviceNode ? element.remotePath : element.remotePath;
		try {
			const entries = await list(controller, this.secrets, remotePath);
			const nodes: FanucNode[] = entries.map((e) =>
				e.isDirectory
					? new DirNode(controller, joinRemote(remotePath, e.name), e.name)
					: new FileNode(controller, joinRemote(remotePath, e.name), e)
			);
			const result = nodes.length ? nodes : [new ErrorNode('(leer)')];
			this.cache.set(key, result);
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return [new ErrorNode(message)];
		}
	}
}

function cacheKey(node: FanucNode): string {
	if (node instanceof ControllerNode) {
		return `c:${node.controller.name}`;
	}
	if (node instanceof DeviceNode) {
		return `d:${node.controller.name}:${node.device}`;
	}
	if (node instanceof DirNode) {
		return `p:${node.controller.name}:${node.remotePath}`;
	}
	return `x:${node.label}`;
}

/** Befehle "Filtern" und "Filter aufheben" für den Controller-Baum. */
export function registerControllerFilter(
	context: vscode.ExtensionContext,
	tree: ControllerTreeProvider,
	view: vscode.TreeView<FanucNode>
): void {
	const apply = (f: FileFilter) => {
		tree.setFilter(f);
		view.message = isActive(f) ? `Filter: ${describeFilter(f)}` : undefined;
		void vscode.commands.executeCommand('setContext', 'fanucLs.controllers.filtered', isActive(f));
	};
	context.subscriptions.push(
		vscode.commands.registerCommand('fanucLs.filter', async () => {
			const current = tree.getFilter();
			const groups = await vscode.window.showQuickPick(
				FILE_TYPE_GROUPS.map((g) => ({ label: g.label, id: g.id, picked: current.groups.includes(g.id) })),
				{ canPickMany: true, placeHolder: 'Welche Dateitypen anzeigen? (nichts angehakt = alle)' }
			);
			if (!groups) {
				return;
			}
			const text = await vscode.window.showInputBox({
				prompt: 'Dateiname enthält … (z. B. HOME, oder mit Platzhaltern H*.LS). Leer = alle Namen.',
				value: current.text
			});
			if (text === undefined) {
				return;
			}
			apply({ groups: groups.map((g) => g.id), text: text.trim() });
		}),
		vscode.commands.registerCommand('fanucLs.clearFilter', () => apply(NO_FILTER))
	);
}
