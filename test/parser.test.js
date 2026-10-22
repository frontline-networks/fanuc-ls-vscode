const test = require('node:test');
const assert = require('node:assert');
const { parse, isValidProgramName, findReferences } = require('../out/parser');

test('Programmnamen mit Ziffern sind gültig (#3)', () => {
	for (const n of ['PICK100', '100_PICK', '1', 'A_1_B', 'MAIN']) {
		assert.ok(isValidProgramName(n), n);
	}
	for (const n of ['PICK-1', 'A.B', 'ÄRGER', '']) {
		assert.ok(!isValidProgramName(n), n);
	}
});

test('Parser liest /PROG-Namen mit führender Ziffer', () => {
	const p = parse('/PROG  100_PICK\r\n/ATTR\r\n/MN\r\n   1:  END ;\r\n/POS\r\n/END\r\n');
	assert.strictEqual(p.progName, '100_PICK');
	assert.strictEqual(p.tpLines.length, 1);
});

test('Referenzen mit Kommentar und Status werden erkannt', () => {
	const refs = findReferences('WAIT DO[6338:ON :PrePosPickupDisk]=ON');
	assert.deepStrictEqual(refs.map((r) => [r.type, r.id]), [['DO', 6338]]);
});

test('Klammern in Kommentaren zählen nicht (#22)', () => {
	const { withoutCommentsAndStrings: w } = require('../out/parser');
	const balanced = (s) => {
		const c = w(s);
		const n = (ch) => c.split(ch).length - 1;
		return n('[') === n(']') && n('(') === n(')');
	};
	for (const line of [
		'DO[1:Greifer (auf]=ON',
		'LBL[3:Teil (li]',
		'R[5:Anzahl (St]=R[5:Anzahl (St]+1',
		'L PR[GP1:3:Home (x] 100% FINE',
		'MESSAGE[Bitte (Taste]',
		'//L P[1] 100mm/sec FINE (',
		'!Kommentar mit ( Klammer',
		'CALL X(1,"a (b")'
	]) {
		assert.ok(balanced(line), line);
	}
	assert.ok(!balanced('IF (R[1]>1,JMP LBL[2]'));
	// Länge und Referenzen bleiben erhalten
	assert.strictEqual(w('DO[1:Greifer (auf]=ON').length, 'DO[1:Greifer (auf]=ON'.length);
	assert.deepStrictEqual(findReferences('DO[12:Greifer (auf]=ON').map((r) => r.type + r.id), ['DO12']);
});
