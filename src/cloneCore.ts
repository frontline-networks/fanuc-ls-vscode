/**
 * Klon eines Controllers in ein lokales Verzeichnis - ohne VS-Code-Abhängigkeit, damit testbar.
 *
 * Aufbau:
 *   <root>/.fanuc-clone.json     Manifest
 *   <root>/md/SCHWEISS1.LS       Datei von md:SCHWEISS1.LS
 *   <root>/ud1/BACKUP/X.LS       Datei von ud1:BACKUP/X.LS
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export const MANIFEST_NAME = '.fanuc-clone.json';

export interface CloneFile {
	remotePath: string;
	/** Prüfsumme der Datei im Klon beim letzten Abgleich */
	sha1: string;
	size: number;
	/**
	 * Inhaltlicher Stand auf dem Roboter beim letzten Abgleich (contentHash). Die Steuerung erzeugt
	 * eine .LS beim Herunterladen neu (Zeitstempel, E/A-Kommentare), deshalb wird nicht byteweise
	 * verglichen (#30). Fehlt bei Klonen älterer Versionen.
	 */
	robotHash?: string;
}

export interface CloneManifest {
	version: 1;
	controller: string;
	host: string;
	created: string;
	updated: string;
	/** Ordnername -> Gerät, z. B. "md" -> "md:" */
	devices: Record<string, string>;
	/** relativer Pfad (mit "/") -> Stand beim letzten Abgleich */
	files: Record<string, CloneFile>;
}

export type ChangeKind = 'modified' | 'added' | 'deleted';

export interface CloneChange {
	kind: ChangeKind;
	/** relativer Pfad mit "/" */
	relPath: string;
	remotePath: string;
}

/** Ordnername für ein Gerät: "md:" -> "md", "ud1:" -> "ud1". */
export function deviceFolder(device: string): string {
	return device.replace(/[:\\/]+$/, '').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'device';
}

/** Remote-Pfad aus Gerät und relativem Pfad innerhalb des Geräts. */
export function remotePathFor(device: string, relInDevice: string): string {
	const base = device.endsWith(':') || device.endsWith('/') ? device : device + '/';
	return base + relInDevice;
}

export async function sha1File(file: string): Promise<string> {
	const buf = await fs.readFile(file);
	return crypto.createHash('sha1').update(buf).digest('hex');
}

export async function readManifest(root: string): Promise<CloneManifest | undefined> {
	try {
		const raw = await fs.readFile(path.join(root, MANIFEST_NAME), 'utf8');
		const m = JSON.parse(raw) as CloneManifest;
		return m && m.version === 1 && m.files ? m : undefined;
	} catch {
		return undefined;
	}
}

export async function writeManifest(root: string, manifest: CloneManifest): Promise<void> {
	manifest.updated = new Date().toISOString();
	await fs.writeFile(path.join(root, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/** Dateiendung ohne Punkt, klein geschrieben. */
export function extOf(name: string): string {
	const m = /\.([^./\\]+)$/.exec(name);
	return m ? m[1].toLowerCase() : '';
}

/** Filter nach Dateitypen; leere Liste = alles. */
export function matchesTypes(name: string, types: string[]): boolean {
	if (!types.length) {
		return true;
	}
	const ext = extOf(name);
	return types.some((t) => t.replace(/^\*?\./, '').toLowerCase() === ext);
}

async function walk(dir: string, rel: string, out: string[]): Promise<void> {
	let entries: import('fs').Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.name.startsWith('.')) {
			continue;
		}
		const childRel = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) {
			await walk(path.join(dir, e.name), childRel, out);
		} else if (e.isFile()) {
			out.push(childRel);
		}
	}
}

/**
 * Vergleicht den Inhalt des Klon-Verzeichnisses mit dem Manifest.
 * Neue Dateien werden nur in Geräteordnern gesucht, die im Manifest stehen.
 */
export async function computeChanges(root: string, manifest: CloneManifest): Promise<CloneChange[]> {
	const changes: CloneChange[] = [];
	for (const [rel, info] of Object.entries(manifest.files)) {
		const abs = path.join(root, ...rel.split('/'));
		let sha: string | undefined;
		try {
			sha = await sha1File(abs);
		} catch {
			changes.push({ kind: 'deleted', relPath: rel, remotePath: info.remotePath });
			continue;
		}
		if (sha !== info.sha1) {
			changes.push({ kind: 'modified', relPath: rel, remotePath: info.remotePath });
		}
	}
	for (const [folder, device] of Object.entries(manifest.devices)) {
		const found: string[] = [];
		await walk(path.join(root, folder), '', found);
		for (const inDevice of found) {
			const rel = `${folder}/${inDevice}`;
			if (!manifest.files[rel]) {
				changes.push({ kind: 'added', relPath: rel, remotePath: remotePathFor(device, inDevice) });
			}
		}
	}
	const order: Record<ChangeKind, number> = { modified: 0, added: 1, deleted: 2 };
	return changes.sort((a, b) => order[a.kind] - order[b.kind] || a.relPath.localeCompare(b.relPath));
}

/** Sucht vom Pfad aufwärts nach einem Klon-Manifest. */
export async function findCloneRoot(start: string): Promise<{ root: string; manifest: CloneManifest } | undefined> {
	let dir = start;
	try {
		if (!(await fs.stat(start)).isDirectory()) {
			dir = path.dirname(start);
		}
	} catch {
		dir = path.dirname(start);
	}
	for (let i = 0; i < 6; i++) {
		const manifest = await readManifest(dir);
		if (manifest) {
			return { root: dir, manifest };
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return undefined;
}

/** Herkunft einer Datei innerhalb eines Klons: Controller und Remote-Pfad. */
export async function originFromClone(localPath: string): Promise<{ controller: string; remotePath: string } | undefined> {
	const clone = await findCloneRoot(localPath);
	if (!clone) {
		return undefined;
	}
	const rel = path.relative(clone.root, localPath).split(path.sep).join('/');
	const known = clone.manifest.files[rel];
	if (known) {
		return { controller: clone.manifest.controller, remotePath: known.remotePath };
	}
	const slash = rel.indexOf('/');
	const device = slash > 0 ? clone.manifest.devices[rel.slice(0, slash)] : undefined;
	if (!device) {
		return undefined;
	}
	return { controller: clone.manifest.controller, remotePath: remotePathFor(device, rel.slice(slash + 1)) };
}

// --- Inhaltlicher Vergleich (#30) ------------------------------------------------------------

/** Kopfeinträge, die die Steuerung beim Erzeugen einer .LS selbst setzt. */
export const VOLATILE_ATTR = ['CREATE', 'MODIFIED', 'FILE_NAME', 'VERSION', 'PROG_SIZE', 'LINE_COUNT', 'MEMORY_SIZE'];

/** Datentypen, deren Kommentar die Steuerung in eckigen Klammern einsetzt, z. B. DO[12:Greifer]. */
const COMMENT_TYPES = 'DI|DO|RI|RO|GI|GO|AI|AO|UI|UO|SI|SO|WI|WO|WSI|WSO|F|M|R|PR|SR|VR|UALM|TIMER';
const COMMENT_RE = new RegExp(`\\b(${COMMENT_TYPES})\\[\\s*([^\\]:\\[]+?)\\s*:[^\\]]*\\]`, 'g');

/**
 * Text für den inhaltlichen Vergleich einer .LS: ohne Zeilenende-Unterschiede, ohne die von der
 * Steuerung gesetzten Kopfeinträge (Datum, Größe …), ohne Kommentare in DO[n:…], R[n:…] usw.,
 * ohne Zeilennummern im /MN-Teil und mit vereinheitlichten Leerzeichen. Andere Dateien bleiben
 * bis auf Zeilenenden unverändert.
 */
export function normalizeForCompare(text: string, fileName: string): string {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	if (!/\.ls$/i.test(fileName)) {
		return lines.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
	}
	const out: string[] = [];
	let section = '';
	for (const raw of lines) {
		const sec = /^\/(\w+)/.exec(raw);
		if (sec) {
			section = sec[1].toUpperCase();
		}
		if (section === 'ATTR') {
			const key = /^\s*([A-Z_]+)\s*=/.exec(raw)?.[1];
			if (key && VOLATILE_ATTR.includes(key)) {
				continue;
			}
		}
		let line = raw.replace(COMMENT_RE, '$1[$2]');
		if (section === 'MN') {
			// Fortsetzungszeilen ("   :  …") gehören zur Zeile davor
			const cont = /^\s*:\s(.*)$/.exec(line);
			if (cont && out.length) {
				out[out.length - 1] += ' ' + cont[1].trim();
				continue;
			}
			line = line.replace(/^\s*\d+:\s*/, '');
		}
		line = line.replace(/\s+/g, ' ').trim();
		if (line) {
			out.push(line);
		}
	}
	return out.join('\n');
}

/** Prüfsumme des Inhalts (normalizeForCompare). */
export function contentHash(buf: Buffer | string, fileName: string): string {
	const text = typeof buf === 'string' ? buf : buf.toString('latin1');
	return crypto.createHash('sha1').update(normalizeForCompare(text, fileName)).digest('hex');
}

export type SyncState = 'changed' | 'new' | 'same' | 'conflict';

export interface SyncCheck {
	state: SyncState;
	/** Begründung für Anwender */
	reason: string;
}

/**
 * Einordnung einer lokalen Änderung gegenüber dem aktuellen Stand auf dem Roboter.
 * robot: undefined = Datei gibt es auf dem Roboter nicht.
 */
export function classifyChange(
	kind: ChangeKind,
	localHash: string,
	robot: { hash: string; sha1: string } | undefined,
	known: CloneFile | undefined
): SyncCheck {
	if (!robot) {
		return kind === 'added'
			? { state: 'new', reason: 'neu, gibt es auf dem Roboter noch nicht' }
			: { state: 'conflict', reason: 'auf dem Roboter nicht vorhanden (dort gelöscht?)' };
	}
	if (robot.hash === localHash) {
		return { state: 'same', reason: 'inhaltlich gleich wie auf dem Roboter (nur Kopfzeilen, Kommentare oder Leerzeichen anders)' };
	}
	if (kind === 'added' || !known) {
		return { state: 'conflict', reason: 'gibt es auf dem Roboter schon mit anderem Inhalt' };
	}
	const unchangedOnRobot = known.robotHash ? robot.hash === known.robotHash : robot.sha1 === known.sha1;
	return unchangedOnRobot
		? { state: 'changed', reason: 'im Klon geändert' }
		: { state: 'conflict', reason: 'auch auf dem Roboter seit dem Klonen geändert' };
}
