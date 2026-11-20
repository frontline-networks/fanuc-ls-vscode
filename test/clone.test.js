const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const core = require('../out/cloneCore');

test('Geräteordner und Remote-Pfade', () => {
	assert.strictEqual(core.deviceFolder('md:'), 'md');
	assert.strictEqual(core.deviceFolder('ud1:'), 'ud1');
	assert.strictEqual(core.remotePathFor('md:', 'A.LS'), 'md:A.LS');
	assert.strictEqual(core.remotePathFor('ud1:', 'BACKUP/A.LS'), 'ud1:BACKUP/A.LS');
});

test('Dateitypfilter', () => {
	assert.ok(core.matchesTypes('SCHWEISS1.LS', ['ls', 'tp']));
	assert.ok(core.matchesTypes('X.tp', ['.TP']));
	assert.ok(!core.matchesTypes('ERRALL.DG', ['ls', 'tp']));
	assert.ok(core.matchesTypes('ERRALL.DG', []));
});

test('Änderungen im Klon erkennen (#10)', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-'));
	await fs.mkdir(path.join(root, 'md'));
	await fs.writeFile(path.join(root, 'md', 'A.LS'), 'alt');
	await fs.writeFile(path.join(root, 'md', 'B.LS'), 'bleibt');
	await fs.writeFile(path.join(root, 'md', 'C.LS'), 'weg');
	const manifest = {
		version: 1, controller: 'R1', host: 'h', created: '', updated: '',
		devices: { md: 'md:' },
		files: {}
	};
	for (const n of ['A.LS', 'B.LS', 'C.LS']) {
		manifest.files[`md/${n}`] = { remotePath: `md:${n}`, sha1: await core.sha1File(path.join(root, 'md', n)), size: 0 };
	}
	await core.writeManifest(root, manifest);
	assert.deepStrictEqual(await core.computeChanges(root, await core.readManifest(root)), []);

	await fs.writeFile(path.join(root, 'md', 'A.LS'), 'neu');
	await fs.rm(path.join(root, 'md', 'C.LS'));
	await fs.writeFile(path.join(root, 'md', 'D.LS'), 'neu angelegt');
	const changes = await core.computeChanges(root, await core.readManifest(root));
	assert.deepStrictEqual(
		changes.map((c) => [c.kind, c.relPath, c.remotePath]),
		[
			['modified', 'md/A.LS', 'md:A.LS'],
			['added', 'md/D.LS', 'md:D.LS'],
			['deleted', 'md/C.LS', 'md:C.LS']
		]
	);
});

test('Herkunft aus Klon-Manifest ableiten (#9)', async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-'));
	await fs.mkdir(path.join(root, 'md'));
	await fs.mkdir(path.join(root, 'ud1', 'BACKUP'), { recursive: true });
	await fs.writeFile(path.join(root, 'md', 'A.LS'), 'x');
	await core.writeManifest(root, {
		version: 1, controller: 'R1', host: 'h', created: '', updated: '',
		devices: { md: 'md:', ud1: 'ud1:' },
		files: { 'md/A.LS': { remotePath: 'md:A.LS', sha1: '', size: 0 } }
	});
	assert.deepStrictEqual(await core.originFromClone(path.join(root, 'md', 'A.LS')), { controller: 'R1', remotePath: 'md:A.LS' });
	assert.deepStrictEqual(await core.originFromClone(path.join(root, 'md', 'NEU.LS')), { controller: 'R1', remotePath: 'md:NEU.LS' });
	assert.deepStrictEqual(await core.originFromClone(path.join(root, 'ud1', 'BACKUP', 'X.LS')), { controller: 'R1', remotePath: 'ud1:BACKUP/X.LS' });
	assert.strictEqual(await core.originFromClone(path.join(os.tmpdir(), 'irgendwo', 'X.LS')), undefined);
});

test('Inhaltlicher Vergleich: Kopf, Kommentare, Zeilennummern zählen nicht (#30)', () => {
	const C = require('../out/cloneCore');
	const robot = [
		'/PROG  TEST',
		'/ATTR',
		'OWNER\t\t= MNEDITOR;',
		'CREATE\t\t= DATE 25-10-22  TIME 10:34:12;',
		'MODIFIED\t= DATE 26-11-20  TIME 06:00:00;',
		'LINE_COUNT\t= 3;',
		'/MN',
		'   1:  DO[12:Greifer offen]=ON ;',
		'   2:  R[5:Zaehler]=R[5:Zaehler]+1    ;',
		'   3:  L P[1:"Start"] 100mm/sec FINE    ;',
		'/POS',
		'/END',
		''
	].join('\r\n');
	const local = ['/PROG TEST', '/ATTR', 'OWNER = MNEDITOR;', 'MODIFIED = DATE 25-01-01 TIME 08:00:00;', '/MN', ' 1: DO[12]=ON ;', ' 2: R[5]=R[5]+1 ;', '  4:  L P[1:"Start"] 100mm/sec FINE ;', '/POS', '/END'].join('\n');
	assert.strictEqual(C.contentHash(robot, 'TEST.LS'), C.contentHash(local, 'TEST.LS'));
	// echte Änderungen bleiben sichtbar: Wert, Positionskommentar, Label
	assert.notStrictEqual(C.contentHash(robot, 'TEST.LS'), C.contentHash(local.replace('DO[12]=ON', 'DO[12]=OFF'), 'TEST.LS'));
	assert.notStrictEqual(C.contentHash(robot, 'TEST.LS'), C.contentHash(local.replace('P[1:"Start"]', 'P[1:"Ende"]'), 'TEST.LS'));
	// Fortsetzungszeilen der Steuerung werden angefügt
	assert.strictEqual(C.normalizeForCompare('/MN\n   1:  CALL A(1,\n    :  2) ;', 'X.LS'), '/MN\nCALL A(1, 2) ;');
	// andere Dateien: nur Zeilenenden
	assert.strictEqual(C.contentHash('a \r\nb\r\n', 'X.DT'), C.contentHash('a\nb', 'X.DT'));
	assert.notStrictEqual(C.contentHash('DO[1:x]', 'X.DT'), C.contentHash('DO[1]', 'X.DT'));
});

test('Einordnung beim Übertragen: gleich, geändert, neu, Konflikt (#30)', () => {
	const C = require('../out/cloneCore');
	const known = { remotePath: 'md:A.LS', sha1: 's0', size: 1, robotHash: 'r0' };
	assert.strictEqual(C.classifyChange('modified', 'L1', { hash: 'L1', sha1: 'x' }, known).state, 'same');
	assert.strictEqual(C.classifyChange('modified', 'L1', { hash: 'r0', sha1: 'x' }, known).state, 'changed', 'Roboter unverändert (Datei neu formatiert)');
	assert.strictEqual(C.classifyChange('modified', 'L1', { hash: 'r9', sha1: 'x' }, known).state, 'conflict');
	assert.strictEqual(C.classifyChange('modified', 'L1', undefined, known).state, 'conflict');
	assert.strictEqual(C.classifyChange('added', 'L1', undefined, undefined).state, 'new');
	assert.strictEqual(C.classifyChange('added', 'L1', { hash: 'r1', sha1: 'x' }, undefined).state, 'conflict');
	// alter Klon ohne robotHash: Byte-Vergleich wie bisher
	const old = { remotePath: 'md:A.LS', sha1: 's0', size: 1 };
	assert.strictEqual(C.classifyChange('modified', 'L1', { hash: 'r9', sha1: 's0' }, old).state, 'changed');
	assert.strictEqual(C.classifyChange('modified', 'L1', { hash: 'r9', sha1: 's9' }, old).state, 'conflict');
});
