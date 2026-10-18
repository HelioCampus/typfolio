// A results page with 75 outcome cards (each with its two charts, drawn live at the page's width),
// and a benchmark that draws the same 150 charts again at the PDF's fixed sizes, away from the page.
//
// Query: ?mode=iframe|div|div-contain&runs=3&outcomes=75&page=1
//   page=0 leaves the results page out, to see what the page itself costs.
// Results are on window.__bench for run.ts; the page also shows them.
import {
  Box, Card, CardContent, CssBaseline, Divider, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LevelsChart, makeOutcomes, PerformanceChart, type Outcome } from './charts.tsx';
import { drawOffscreen, stageModes, type StageMode, type StageTiming } from './stages.tsx';

declare global {
  interface Window {
    __bench?: { status: 'running' | 'done' | 'error'; results: StageTiming[]; error?: string };
  }
}

const params = new URLSearchParams(location.search);
const mode = params.get('mode') as StageMode | null;
const runs = Number(params.get('runs') ?? 3);
const outcomes = makeOutcomes(Number(params.get('outcomes') ?? 75));
const showPage = params.get('page') !== '0';
const theme = createTheme();

function exportCharts(list: Outcome[]): ReactElement[] {
  return list.flatMap(outcome => [
    <PerformanceChart key="p" percent={outcome.percent} goal={outcome.goal} width={720} height={87} animate={false} />,
    <LevelsChart key="l" levels={outcome.levels} width={720} height={200} animate={false} />,
  ]);
}

function OutcomeCard({ outcome }: { outcome: Outcome }) {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h6">{outcome.name}</Typography>
        <Typography variant="body2" color="text.secondary">{outcome.description}</Typography>
        <Divider sx={{ my: 1 }} />
        <PerformanceChart percent={outcome.percent} goal={outcome.goal} height={100} animate={false} />
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <Box sx={{ flex: 2, minWidth: 0 }}>
            <LevelsChart levels={outcome.levels} height={220} animate={false} />
          </Box>
          <Table size="small" sx={{ flex: 1 }}>
            <TableHead>
              <TableRow><TableCell>Level</TableCell><TableCell align="right">Students</TableCell></TableRow>
            </TableHead>
            <TableBody>
              {outcome.levels.map(level => (
                <TableRow key={level.name}>
                  <TableCell>{level.name}</TableCell>
                  <TableCell align="right">{level.value}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Stack>
      </CardContent>
    </Card>
  );
}

function Bench() {
  const [results, setResults] = useState<StageTiming[]>([]);
  const [busy, setBusy] = useState(false);

  const run = async (modes: readonly StageMode[], count: number) => {
    setBusy(true);
    window.__bench = { status: 'running', results: [] };
    try {
      // Let the page's own charts finish drawing first.
      await new Promise(resolve => setTimeout(resolve, 1000));
      const all: StageTiming[] = [];
      for (const each of modes) {
        await drawOffscreen(each, exportCharts(outcomes), theme); // warm-up, not recorded
        for (let index = 0; index < count; index += 1) {
          const timing = await drawOffscreen(each, exportCharts(outcomes), theme);
          all.push(timing);
          setResults([...all]);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      window.__bench = { status: 'done', results: all };
    } catch (error) {
      window.__bench = { status: 'error', results: [], error: String(error) };
      throw error;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (mode) void run([mode], runs);
  }, []);

  return (
    <Box sx={{ p: 2, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}>
      <Typography variant="h5">Offscreen chart drawing: {outcomes.length * 2} charts{showPage ? '' : ', no page'}</Typography>
      <Stack direction="row" spacing={1} sx={{ my: 1 }}>
        <button disabled={busy} onClick={() => void run(stageModes, runs)}>Run all modes</button>
        {stageModes.map(each => (
          <button key={each} disabled={busy} onClick={() => void run([each], runs)}>{each}</button>
        ))}
      </Stack>
      <table>
        <thead>
          <tr><th>mode</th><th>draw ms</th><th>wait ms</th><th>serialize ms</th><th>total ms</th><th>KB</th></tr>
        </thead>
        <tbody>
          {results.map((row, index) => (
            <tr key={index}>
              <td>{row.mode}</td>
              <td>{row.drawMs.toFixed(0)}</td>
              <td>{row.waitMs.toFixed(0)}</td>
              <td>{row.serializeMs.toFixed(0)}</td>
              <td>{row.totalMs.toFixed(0)}</td>
              <td>{(row.bytes / 1024).toFixed(0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Box>
  );
}

function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Bench />
      {showPage && (
        <Stack spacing={2} sx={{ p: 2 }}>
          {outcomes.map(outcome => <OutcomeCard key={outcome.name + outcome.percent} outcome={outcome} />)}
        </Stack>
      )}
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
