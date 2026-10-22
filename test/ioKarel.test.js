const test = require('node:test');
const assert = require('node:assert');
const K = require('../out/ioKarel');

test('KAREL-Programm für E/A-Kommentare (#21)', () => {
	const r = K.buildIoCommentProgram(
		[
			{ type: 'DO', index: 12, comment: 'Greifer zu' },
			{ type: 'DI', index: 3, comment: "Teil da 'links' Größe" },
			{ type: 'M', index: 1, comment: 'Merker' },
			{ type: 'GO', index: 2, comment: 'Programmnummer an Schweissgeraet lang' }
		],
		'R1 Zelle'
	);
	assert.strictEqual(r.written, 3);
	assert.deepStrictEqual(r.skipped, ['M']);
	assert.deepStrictEqual(r.truncated, ['GO[2]']);
	assert.match(r.source, /^PROGRAM FLIOCMT\r\n/);
	assert.match(r.source, /setc\(io_din, 3, 'Teil da `links` Groesse'\)/);
	assert.match(r.source, /setc\(io_dout, 12, 'Greifer zu'\)/);
	assert.match(r.source, /setc\(io_gpout, 2, 'Programmnummer an Schwei'\)/);
	assert.match(r.source, /END FLIOCMT\r\n$/);
	// DI vor DO (sortiert nach Typreihenfolge)
	assert.ok(r.source.indexOf('io_din') < r.source.indexOf('io_dout'));
});

test('Diagnosedateien sind nicht hochladbar', () => {
	assert.ok(K.isReadOnlyReport('IOSTATE.DG'));
	assert.ok(K.isReadOnlyReport('errall.ls'));
	assert.ok(K.isReadOnlyReport('LOGBOOK.LS'));
	assert.ok(!K.isReadOnlyReport('HOME.LS'));
	assert.ok(!K.isReadOnlyReport('ARGDISPEG01.DT'));
});
