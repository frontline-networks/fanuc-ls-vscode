const test = require('node:test');
const assert = require('node:assert');
const R = require('../out/cloneReport');

const OLD = [
	'/PROG  NAHT',
	'/ATTR',
	'COMMENT\t\t= "Naht";',
	'MODIFIED\t= DATE 26-10-01  TIME 08:00:00;',
	'/MN',
	'   1:L P[1] 10mm/sec FINE    ;',
	'   2:L P[2] 10mm/sec FINE    ;',
	'/POS',
	'P[1]{',
	'   GP1:',
	'\tX =   100.000  mm',
	'};',
	'P[2:Ende]{',
	'   GP1:',
	'\tX =   200.000  mm',
	'};',
	'/END'
].join('\r\n');
const NEW = OLD.replace('2:L P[2] 10mm', '2:L P[2] 12mm').replace('MODIFIED\t= DATE 26-10-01', 'MODIFIED\t= DATE 26-10-22').replace('200.000', '210.000');

test('Zeilenvergleich (#24)', () => {
	const d = R.diffLines('a\nb\nc\nd', 'a\nx\nc\nd\ne');
	assert.deepStrictEqual(d.map((x) => x.kind + x.text), [' a', '-b', '+x', ' c', ' d', '+e']);
	assert.deepStrictEqual(R.diffLines('a\nb', 'a\nb').filter((x) => x.kind !== ' '), []);
	// Fallback für sehr große Unterschiede
	const big = R.diffLines('a\nb\nc', 'x\ny\nz', 1);
	assert.strictEqual(big.filter((x) => x.kind === '-').length, 3);
});

test('Zusammenfassung für TP-Programme', () => {
	const s = R.summarizeLs(R.diffLines(OLD, NEW));
	assert.deepStrictEqual(s.tpLines, [2]);
	assert.deepStrictEqual(s.positions, ['P[2]']);
	assert.deepStrictEqual(s.attrs, []);
	assert.strictEqual(R.compactNumbers([1, 2, 3, 5, 7, 8]), '1–3, 5, 7–8');
});

test('Bericht mit Übersicht, Konflikt und Diff', () => {
	const md = R.buildReport({ controller: 'R1', cloneRoot: '/k', created: new Date(2026, 9, 22, 9, 5) }, [
		{ change: { kind: 'modified', relPath: 'md/NAHT.LS', remotePath: 'md:NAHT.LS' }, robotText: OLD, localText: NEW, conflict: false },
		{ change: { kind: 'modified', relPath: 'md/X.LS', remotePath: 'md:X.LS' }, robotText: 'a', localText: 'b', conflict: true },
		{ change: { kind: 'added', relPath: 'md/NEU.LS', remotePath: 'md:NEU.LS' }, localText: 'x\ny', conflict: false },
		{ change: { kind: 'deleted', relPath: 'md/ALT.LS', remotePath: 'md:ALT.LS' }, conflict: false }
	]);
	assert.match(md, /# Änderungsbericht – Klon von R1/);
	assert.match(md, /22\.10\.2026 09:05/);
	assert.match(md, /\| `md\/NAHT.LS` → `md:NAHT.LS` \| geändert \| \+3 \/ −3 Zeilen \|/);
	assert.match(md, /Programmzeilen \(neuer Stand\): 2/);
	assert.match(md, /Positionen: P\[2\]/);
	assert.match(md, /-   2:L P\[2\] 10mm\/sec FINE/);
	assert.match(md, /\+   2:L P\[2\] 12mm\/sec FINE/);
	assert.match(md, /1 Datei\(en\) wurden auf dem Roboter seit dem Klonen geändert/);
	assert.match(md, /neu auf dem Roboter/);
	assert.match(md, /bleibt auf dem Roboter/);
});
