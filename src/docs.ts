/**
 * FANUC-Dokumentation aus einem lokalen Ordner (#13): durchsuchen, nachschlagen,
 * und als Werkzeug für GitHub Copilot bereitstellen. Ordner: fanucLs.docs.folder.
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { DocChunk, SearchHit, chunkPages, chunkText, matchLine, search, terms } from './docsCore';

const EXTENSIONS = ['.pdf', '.txt', '.md'];
const SCHEME = 'fanuc-docs';
const CACHE_VERSION = 1;

interface CachedFile {
	mtime: number;
	size: number;
	chunks: DocChunk[];
	/** PDF-Seiten ohne Text (gescannt) */
	emptyPages: number;
	pages: number;
	error?: string;
}

interface Cache {
	version: number;
	files: Record<string, CachedFile>;
}

/** Ordner bzw. Datei aus der Einstellung: ~ und ${workspaceFolder} werden aufgelöst. */
export function docsPath(): string | undefined {
	const raw = vscode.workspace.getConfiguration('fanucLs').get<string>('docs.folder', '').trim();
	if (!raw) {
		return undefined;
	}
	const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
	let p = raw.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/\$\{workspaceFolder\}/g, ws);
	if (!path.isAbsolute(p) && ws) {
		p = path.join(ws, p);
	}
	return p;
}

// pdf.js ist ein ES-Modul; "import()" darf TypeScript nicht in require() übersetzen
const importModule = new Function('u', 'return import(u)') as (u: string) => Promise<any>;

export class DocsIndex implements vscode.Disposable {
	private cache: Cache = { version: CACHE_VERSION, files: {} };
	private loaded = false;
	private building?: Promise<void>;
	private dirty = true;
	private watcher?: vscode.FileSystemWatcher;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;

	constructor(private readonly storage: vscode.Uri, private readonly extensionPath: string) {
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('fanucLs.docs.folder')) {
					this.dirty = true;
					this.watch();
					void this.ensure(true);
				}
			})
		);
		this.watch();
	}

	dispose(): void {
		this.watcher?.dispose();
		this.disposables.forEach((d) => d.dispose());
		this.emitter.dispose();
	}

	private watch(): void {
		this.watcher?.dispose();
		this.watcher = undefined;
		const root = docsPath();
		if (!root) {
			return;
		}
		this.watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(root), '**/*.{pdf,PDF,txt,TXT,md,MD}')
		);
		const mark = () => (this.dirty = true);
		this.watcher.onDidCreate(mark);
		this.watcher.onDidChange(mark);
		this.watcher.onDidDelete(mark);
	}

	get chunks(): DocChunk[] {
		return Object.values(this.cache.files).flatMap((f) => f.chunks);
	}

	stats(): { files: number; chunks: number; emptyPages: number; scanned: string[]; errors: string[] } {
		const entries = Object.entries(this.cache.files);
		return {
			files: entries.length,
			chunks: this.chunks.length,
			emptyPages: entries.reduce((n, [, f]) => n + f.emptyPages, 0),
			scanned: entries.filter(([, f]) => f.pages > 0 && f.chunks.length === 0).map(([p]) => path.basename(p)),
			errors: entries.filter(([, f]) => f.error).map(([p, f]) => `${path.basename(p)}: ${f.error}`)
		};
	}

	/** Index bei Bedarf aktualisieren (nur neue/geänderte Dateien werden gelesen). */
	async ensure(showProgress = false): Promise<void> {
		if (!this.loaded) {
			await this.loadCache();
		}
		if (!this.dirty) {
			return this.building;
		}
		if (!this.building) {
			this.building = this.build(showProgress).finally(() => (this.building = undefined));
		}
		return this.building;
	}

	async rebuild(): Promise<void> {
		this.cache.files = {};
		this.dirty = true;
		await this.ensure(true);
	}

	private async build(showProgress: boolean): Promise<void> {
		this.dirty = false;
		const root = docsPath();
		if (!root) {
			this.cache.files = {};
			this.emitter.fire();
			return;
		}
		const files = await listFiles(root);
		const work = async (progress?: vscode.Progress<{ message?: string; increment?: number }>) => {
			const next: Record<string, CachedFile> = {};
			let i = 0;
			for (const f of files) {
				i++;
				const stat = await fs.stat(f).catch(() => undefined);
				if (!stat) {
					continue;
				}
				const old = this.cache.files[f];
				if (old && old.mtime === stat.mtimeMs && old.size === stat.size) {
					next[f] = old;
					continue;
				}
				progress?.report({ message: `${i}/${files.length} ${path.basename(f)}`, increment: 100 / files.length });
				next[f] = await this.read(f, stat.mtimeMs, stat.size);
			}
			this.cache.files = next;
			await this.saveCache();
			this.emitter.fire();
		};
		const changed = files.some((f) => !this.cache.files[f]);
		if (showProgress || changed) {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: 'FANUC-Doku wird eingelesen' },
				(p) => work(p)
			);
		} else {
			await work();
		}
	}

	private async read(file: string, mtime: number, size: number): Promise<CachedFile> {
		try {
			if (/\.pdf$/i.test(file)) {
				const pages = await this.pdfPages(file);
				return { mtime, size, pages: pages.length, emptyPages: pages.filter((p) => !p.trim()).length, chunks: chunkPages(file, pages) };
			}
			const text = await fs.readFile(file, 'utf8');
			return { mtime, size, pages: 0, emptyPages: 0, chunks: chunkText(file, text) };
		} catch (err) {
			return { mtime, size, pages: 0, emptyPages: 0, chunks: [], error: err instanceof Error ? err.message : String(err) };
		}
	}

	private async pdfPages(file: string): Promise<string[]> {
		const lib = pathToFileURL(path.join(this.extensionPath, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href;
		const pdfjs = await importModule(lib);
		const data = new Uint8Array(await fs.readFile(file));
		const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
		const pages: string[] = [];
		try {
			for (let i = 1; i <= doc.numPages; i++) {
				const page = await doc.getPage(i);
				const content = await page.getTextContent();
				pages.push(
					content.items
						.map((it: { str?: string; hasEOL?: boolean }) => (it.str ?? '') + (it.hasEOL ? '\n' : ''))
						.join('')
						.replace(/-\n(?=[a-zäöü])/g, '')
				);
				page.cleanup();
			}
		} finally {
			await doc.destroy();
		}
		return pages;
	}

	private cacheFile(): vscode.Uri {
		return vscode.Uri.joinPath(this.storage, 'docs-index.json');
	}

	private async loadCache(): Promise<void> {
		this.loaded = true;
		try {
			const raw = JSON.parse(await fs.readFile(this.cacheFile().fsPath, 'utf8')) as Cache;
			if (raw.version === CACHE_VERSION) {
				this.cache = raw;
			}
		} catch {
			/* noch kein Zwischenspeicher */
		}
	}

	private async saveCache(): Promise<void> {
		try {
			await fs.mkdir(this.storage.fsPath, { recursive: true });
			await fs.writeFile(this.cacheFile().fsPath, JSON.stringify(this.cache), 'utf8');
		} catch {
			/* Zwischenspeicher ist optional */
		}
	}

	async search(query: string, limit = 20): Promise<SearchHit[]> {
		await this.ensure();
		return search(this.chunks, query, limit);
	}
}

async function listFiles(root: string, depth = 0): Promise<string[]> {
	const stat = await fs.stat(root).catch(() => undefined);
	if (!stat) {
		return [];
	}
	if (stat.isFile()) {
		return EXTENSIONS.includes(path.extname(root).toLowerCase()) ? [root] : [];
	}
	if (depth > 6) {
		return [];
	}
	const out: string[] = [];
	for (const e of await fs.readdir(root, { withFileTypes: true })) {
		if (e.name.startsWith('.')) {
			continue;
		}
		const p = path.join(root, e.name);
		if (e.isDirectory()) {
			out.push(...(await listFiles(p, depth + 1)));
		} else if (EXTENSIONS.includes(path.extname(e.name).toLowerCase())) {
			out.push(p);
		}
	}
	return out.sort();
}

function location(c: DocChunk): string {
	return /\.pdf$/i.test(c.file) ? `${path.basename(c.file)}, Seite ${c.page}` : `${path.basename(c.file)}, ${c.title}`;
}

/** Inhalt eines Abschnitts als Markdown-Ansicht (fanuc-docs:/…?page=n). */
class DocsContentProvider implements vscode.TextDocumentContentProvider {
	constructor(private readonly index: DocsIndex) {}
	provideTextDocumentContent(uri: vscode.Uri): string {
		const q = new URLSearchParams(uri.query);
		const file = q.get('file') ?? '';
		const page = Number(q.get('page'));
		const c = this.index.chunks.find((x) => x.file === file && x.page === page);
		if (!c) {
			return 'Abschnitt nicht mehr im Index. Bitte erneut suchen.';
		}
		return `${location(c)}\n${'='.repeat(location(c).length)}\n\nQuelle: ${c.file}\n\n${c.text}\n`;
	}
}

export function registerDocs(context: vscode.ExtensionContext): DocsIndex {
	const index = new DocsIndex(context.globalStorageUri, context.extensionPath);
	context.subscriptions.push(index, vscode.workspace.registerTextDocumentContentProvider(SCHEME, new DocsContentProvider(index)));

	const needFolder = async (): Promise<boolean> => {
		if (docsPath()) {
			return true;
		}
		const a = await vscode.window.showInformationMessage(
			'Es ist noch kein Ordner mit FANUC-Dokumentation festgelegt (Handbücher als PDF, Text oder Markdown).',
			'Ordner festlegen …'
		);
		if (a) {
			await vscode.commands.executeCommand('fanucLs.docs.setFolder');
		}
		return !!docsPath();
	};

	const openHit = async (hit: SearchHit, query: string) => {
		const c = hit.chunk;
		if (c.line !== undefined) {
			// Text/Markdown: Originaldatei öffnen und zur Fundstelle springen
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(c.file));
			const line = c.line + matchLine(c.text, query);
			const editor = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
			const range = new vscode.Range(line, 0, line, 0);
			editor.selection = new vscode.Selection(range.start, range.start);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
			return;
		}
		const uri = vscode.Uri.from({
			scheme: SCHEME,
			path: `/${path.basename(c.file)} S${c.page}.md`,
			query: new URLSearchParams({ file: c.file, page: String(c.page) }).toString()
		});
		const doc = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
		const line = 5 + matchLine(c.text, query);
		const range = new vscode.Range(line, 0, line, 0);
		editor.selection = new vscode.Selection(range.start, range.start);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
	};

	const runSearch = async (initial?: string) => {
		if (!(await needFolder())) {
			return;
		}
		const query = await vscode.window.showInputBox({
			prompt: 'In der FANUC-Dokumentation suchen (z. B. SKIP CONDITION, FILE-097, Positionsregister)',
			value: initial ?? ''
		});
		if (!query?.trim()) {
			return;
		}
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'FANUC-Doku' }, () => index.ensure(true));
		const hits = await index.search(query, 50);
		const st = index.stats();
		if (hits.length === 0) {
			const extra = st.files === 0 ? ` Im Ordner ${docsPath()} wurden keine PDF-, Text- oder Markdown-Dateien gefunden.` : st.scanned.length ? ` Hinweis: ${st.scanned.length} PDF(s) enthalten keinen Text (gescannt) und sind nicht durchsuchbar.` : '';
			vscode.window.showInformationMessage(`Keine Treffer für „${query}“ in ${st.files} Datei(en).${extra}`);
			return;
		}
		const openPdf: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Originaldatei öffnen' };
		const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { hit: SearchHit }>();
		qp.title = `FANUC-Doku: ${hits.length} Treffer für „${query}“`;
		qp.matchOnDetail = true;
		qp.items = hits.map((h) => ({
			label: `$(${/\.pdf$/i.test(h.chunk.file) ? 'file-pdf' : 'file-text'}) ${location(h.chunk)}`,
			description: /\.pdf$/i.test(h.chunk.file) ? h.chunk.title : '',
			detail: h.snippet,
			buttons: [openPdf],
			hit: h
		}));
		qp.onDidTriggerItemButton(async (e) => {
			await vscode.env.openExternal(vscode.Uri.file(e.item.hit.chunk.file));
		});
		qp.onDidAccept(async () => {
			const item = qp.selectedItems[0];
			qp.hide();
			if (item) {
				await openHit(item.hit, query);
			}
		});
		qp.onDidHide(() => qp.dispose());
		qp.show();
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('fanucLs.docs.search', () => runSearch()),
		vscode.commands.registerCommand('fanucLs.docs.lookup', async () => {
			const editor = vscode.window.activeTextEditor;
			let word = '';
			if (editor) {
				word = editor.document.getText(editor.selection).trim();
				if (!word) {
					// Befehl unter dem Cursor, auch mehrteilig (SKIP CONDITION) und Codes (FILE-097)
					const range = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z][A-Za-z0-9_]*(?:[- ][A-Za-z0-9_]+)?/);
					word = range ? editor.document.getText(range) : '';
				}
			}
			await runSearch(word.replace(/\s+/g, ' ').slice(0, 80));
		}),
		vscode.commands.registerCommand('fanucLs.docs.setFolder', async () => {
			const picked = await vscode.window.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: true,
				canSelectMany: false,
				openLabel: 'Als FANUC-Doku verwenden',
				filters: { Dokumentation: ['pdf', 'txt', 'md'] },
				title: 'Ordner (oder einzelne Datei) mit FANUC-Handbüchern wählen'
			});
			if (!picked?.[0]) {
				return;
			}
			await vscode.workspace.getConfiguration('fanucLs').update('docs.folder', picked[0].fsPath, vscode.ConfigurationTarget.Global);
			await index.rebuild();
			const st = index.stats();
			vscode.window.showInformationMessage(
				`FANUC-Doku: ${st.files} Datei(en), ${st.chunks} Abschnitte durchsuchbar.` +
					(st.scanned.length ? ` Ohne Text (gescannt, vorher Texterkennung nötig): ${st.scanned.join(', ')}.` : '') +
					(st.errors.length ? ` Nicht lesbar: ${st.errors.join('; ')}` : '')
			);
		}),
		vscode.commands.registerCommand('fanucLs.docs.reindex', async () => {
			if (!(await needFolder())) {
				return;
			}
			await index.rebuild();
			const st = index.stats();
			vscode.window.showInformationMessage(
				`FANUC-Doku neu eingelesen: ${st.files} Datei(en), ${st.chunks} Abschnitte.` +
					(st.scanned.length ? ` Ohne Text (gescannt): ${st.scanned.join(', ')}.` : '') +
					(st.emptyPages ? ` ${st.emptyPages} Seite(n) ohne Text.` : '')
			);
		})
	);

	registerCopilotTool(context, index);
	if (docsPath()) {
		// im Hintergrund vorbereiten, damit die erste Suche schnell ist
		setTimeout(() => void index.ensure().catch(() => undefined), 5000);
	}
	return index;
}

/** Werkzeug für GitHub Copilot (Agent-Modus): "#fanucDocs" bzw. automatisch bei FANUC-Fragen. */
function registerCopilotTool(context: vscode.ExtensionContext, index: DocsIndex): void {
	const lm = (vscode as unknown as { lm?: { registerTool?: typeof vscode.lm.registerTool } }).lm;
	if (!lm?.registerTool) {
		return; // ältere VS-Code-Version ohne Werkzeug-API
	}
	context.subscriptions.push(
		lm.registerTool<{ query: string; maxResults?: number }>('fanuc_docs_search', {
			prepareInvocation: (options) => ({ invocationMessage: `FANUC-Doku durchsuchen: „${options.input.query}“` }),
			invoke: async (options) => {
				const query = String(options.input.query ?? '').trim();
				const limit = Math.min(Math.max(Number(options.input.maxResults) || 5, 1), 10);
				let text: string;
				if (!docsPath()) {
					text = 'Es ist kein Ordner mit FANUC-Dokumentation konfiguriert (Einstellung fanucLs.docs.folder). Der Anwender kann ihn über den Befehl "FANUC: Doku-Ordner festlegen" einrichten.';
				} else if (terms(query).length === 0) {
					text = 'Bitte einen konkreten Suchbegriff angeben, z. B. einen Befehl (SKIP CONDITION), Alarmcode (SRVO-062) oder Begriff (Positionsregister).';
				} else {
					const hits = await index.search(query, limit);
					text = hits.length
						? hits
								.map((h, i) => `### Treffer ${i + 1}: ${location(h.chunk)}\nQuelle: ${h.chunk.file}\n\n${h.chunk.text.slice(0, 2500)}`)
								.join('\n\n---\n\n') +
							'\n\nBeim Antworten die Quelle (Datei und Seite) angeben. Inhalte stammen aus den lokalen Handbüchern des Anwenders.'
						: `Keine Treffer für "${query}" in der lokalen FANUC-Dokumentation (${index.stats().files} Datei(en)). Andere Begriffe versuchen, z. B. englische Bezeichnungen aus dem Handbuch.`;
				}
				return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
			}
		})
	);
}
