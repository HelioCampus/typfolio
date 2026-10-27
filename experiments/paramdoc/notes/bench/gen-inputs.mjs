// Generates the paramdoc benchmark inputs from the repo's own synthetic generator (same seeds as the browser benchmark).
import { reportInput } from '../../../../examples/pretext-hybrid/src/batch/data.ts';
import { writeFileSync } from 'node:fs';
const count = Number(process.argv[2] ?? 1000);
const inputs = [];
for (let n = 1; n <= count; n++) {
  const r = reportInput(n);
  const average = Math.round(r.courses.reduce((a, c) => a + c.score, 0) / r.courses.length);
  inputs.push({
    number: r.number, name: r.student.name, studentId: r.student.studentId, programme: r.student.programme, term: r.term,
    average, course_count: r.courses.length, attendance: `${r.attendance}%`,
    courses: r.courses.map(c => ({ code: c.code, title: c.title, score: c.score, grade: c.grade })),
    comment: r.comment,
  });
}
writeFileSync(process.argv[3], JSON.stringify(inputs));
const rows = inputs.reduce((a, i) => a + i.courses.length, 0);
console.log(`${inputs.length} inputs, ${rows} course rows (${(rows / inputs.length).toFixed(2)} per report), max courses ${Math.max(...inputs.map(i => i.courses.length))}, longest comment ${Math.max(...inputs.map(i => i.comment.length))} chars, longest title ${Math.max(...inputs.flatMap(i => i.courses.map(c => c.title.length)))}`);
