// Two charts shaped like an assessment results card: a Highcharts bullet chart (performance
// against a goal) and an MUI X bar chart (students per proficiency level). Synthetic data only.
import { BarChart } from '@mui/x-charts/BarChart';
import Highcharts from 'highcharts';
import HighchartsReactModule from 'highcharts-react-official';
import accessibility from 'highcharts/modules/accessibility.js';
import bullet from 'highcharts/modules/bullet.js';

bullet(Highcharts);
accessibility(Highcharts);
// The package is CommonJS: depending on the bundler's interop its default import is the component
// or the module object.
const HighchartsReact = ((HighchartsReactModule as unknown as { default?: typeof HighchartsReactModule }).default ??
  HighchartsReactModule);

export interface Outcome {
  name: string;
  description: string;
  percent: number;
  goal: number;
  levels: { name: string; value: number; color: string }[];
}

const levelNames = ['Exemplary', 'Proficient', 'Developing', 'Beginning', 'Not observed'];
const levelColors = ['#1b5e20', '#43a047', '#fbc02d', '#ef6c00', '#9e9e9e'];

export function makeOutcomes(count: number): Outcome[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Outcome ${index + 1}: Communicate findings to a technical audience`,
    description:
      'Students explain a method, its assumptions and its limits in writing, with figures and ' +
      'citations a reader can follow and check.',
    percent: (index * 37) % 100,
    goal: 70,
    levels: levelNames.map((name, level) => ({
      name,
      value: ((index + 3) * (level + 5)) % 23,
      color: levelColors[level],
    })),
  }));
}

interface Size {
  width?: number;
  height: number;
  animate: boolean;
}

export function PerformanceChart({ percent, goal, width, height, animate }: Pick<Outcome, 'percent' | 'goal'> & Size) {
  const options: Highcharts.Options = {
    chart: { inverted: true, type: 'bullet', height, ...(width ? { width } : {}), animation: animate },
    title: { text: 'Performance goal', align: 'left', style: { fontSize: '14px', fontWeight: '700' } },
    credits: { enabled: false },
    legend: { enabled: false },
    xAxis: { categories: [''] },
    yAxis: {
      min: 0,
      max: 100,
      gridLineWidth: 0,
      title: { text: null },
      labels: { format: '{value}%' },
      plotBands: [
        { from: 0, to: goal, color: '#ffebee' },
        { from: goal, to: 100, color: '#e8f5e9' },
      ],
    },
    plotOptions: { series: { animation: animate, borderWidth: 0, color: '#1565c0' } },
    series: [{ type: 'bullet', data: [{ y: percent, target: goal }] }],
  };
  return <HighchartsReact highcharts={Highcharts} options={options} />;
}

export function LevelsChart({ levels, width, height, animate }: Pick<Outcome, 'levels'> & Size) {
  return (
    <BarChart
      xAxis={[
        {
          data: levels.map(level => level.name),
          scaleType: 'band',
          colorMap: { type: 'ordinal', colors: levels.map(level => level.color) },
        },
      ]}
      yAxis={[{ tickNumber: 4 }]}
      series={[{ data: levels.map(level => level.value) }]}
      height={height}
      width={width}
      skipAnimation={!animate}
      barLabel="value"
      borderRadius={4}
      hideLegend
      grid={{ horizontal: true }}
    />
  );
}
