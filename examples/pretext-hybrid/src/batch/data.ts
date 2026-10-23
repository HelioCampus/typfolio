// Synthetic inputs for ./report/main.typ; keep in step with ./report/report.schema.json.
// Every value is generated from a seeded random source, so a given document number always gets the same data.

export interface Course {
  readonly code: string;
  readonly title: string;
  readonly score: number;
  readonly grade: string;
}

export interface ReportInput {
  readonly number: number;
  readonly student: { readonly name: string; readonly studentId: string; readonly programme: string };
  readonly term: string;
  readonly courses: readonly Course[];
  readonly attendance: number;
  readonly comment: string;
}

const firstNames = ['Ada', 'Bilal', 'Chen', 'Dara', 'Elif', 'Femi', 'Greta', 'Hana', 'Ilya', 'Jonas', 'Kemal', 'Lena', 'Mateo', 'Noor', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sami', 'Tara', 'Uma', 'Viktor', 'Wen', 'Yara', 'Zeynep'];
const lastNames = ['Archer', 'Bakir', 'Costa', 'Doyle', 'Eriksen', 'Fontaine', 'Garcia', 'Haddad', 'Ito', 'Jensen', 'Kaya', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrov', 'Quist', 'Rossi', 'Silva', 'Tanaka', 'Uddin', 'Varga', 'Weber', 'Yilmaz', 'Zhou'];
const programmes = ['BSc Computer Science', 'BA History', 'BSc Biology', 'BEng Civil Engineering', 'BA Economics', 'BSc Mathematics'];
const courseTitles: readonly (readonly [string, string])[] = [
  ['CS101', 'Introduction to Programming'],
  ['MA120', 'Linear Algebra'],
  ['HI210', 'Modern European History'],
  ['BI150', 'Cell Biology'],
  ['EC110', 'Principles of Economics'],
  ['EN105', 'Academic Writing'],
  ['PH130', 'Physics for Engineers'],
  ['ST200', 'Statistics and Data'],
  ['PS101', 'Introduction to Psychology'],
  ['CE220', 'Structural Analysis'],
];
const openers = ['Consistent effort across the term.', 'A strong term overall.', 'Steady progress since the midterm.', 'Engaged and curious in seminars.'];
const closers = [
  'Keep building on the written work, which improved noticeably.',
  'More regular practice with problem sets would lift the lower scores.',
  'Group work was a clear strength this term.',
  'Attendance at office hours paid off in the final assessments.',
];

/** Small deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grade(score: number): string {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function reportInput(number: number): ReportInput {
  const next = random(number * 7919);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const shuffled = [...courseTitles].sort(() => next() - 0.5);
  const courses = shuffled.slice(0, 4 + Math.floor(next() * 4)).map(([code, title]) => {
    const score = Math.round(35 + next() * 64);
    return { code, title, score, grade: grade(score) };
  });
  return {
    number,
    student: {
      name: `${pick(firstNames)} ${pick(lastNames)}`,
      studentId: String(100000 + Math.floor(next() * 900000)),
      programme: pick(programmes),
    },
    term: pick(['Autumn 2026', 'Spring 2026']),
    courses,
    attendance: Math.round(70 + next() * 30),
    comment: `${pick(openers)} ${pick(closers)}`,
  };
}

export function fileName(number: number): string {
  return `report-${String(number).padStart(4, '0')}.pdf`;
}
