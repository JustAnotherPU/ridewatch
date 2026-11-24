'use strict';
// fake player: fake_player.js <out file> <port> <rate>; appends its stdin to the out file (its first line: port rate)
const fs = require('fs');
const out = process.argv[2];
fs.writeFileSync(out, process.argv[3] + ' ' + process.argv[4] + '\n');
fs.writeFileSync(out + '.id', process.getuid() + ':' + process.getgid() + ':' + process.getgroups().join(','));   // who it runs as
process.stdin.on('data', (d) => fs.appendFileSync(out, d));
process.stdin.on('end', () => process.exit(0));
