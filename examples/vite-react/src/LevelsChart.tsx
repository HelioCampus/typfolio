import { createContext, useContext } from 'react';

export interface Level {
  readonly name: string;
  readonly students: number;
}

/** App context the chart reads: the stage that draws charts for the PDF is portalled from the app's tree, so it sees it too. */
export const ChartGoalColor = createContext('#ef6a3a');

interface LevelsChartProps {
  readonly levels: readonly Level[];
  /** Students needed at Proficient or above. */
  readonly goal: number;
  readonly width: number;
  readonly height: number;
}

const axis = 28;
// Room above the tallest bar for its value label.
const top = 18;

/**
 * Students per proficiency level. Bar colours come from the page stylesheet (`.levels-chart__bar--N`),
 * the goal line's colour from React context: both reach the copy drawn for the PDF.
 */
export function LevelsChart({ levels, goal, width, height }: LevelsChartProps) {
  const goalColor = useContext(ChartGoalColor);
  const max = Math.max(goal, ...levels.map(level => level.students), 1);
  const plotHeight = height - axis - top;
  const band = (width - 8) / levels.length;
  const y = (value: number) => top + plotHeight * (1 - value / max);
  return (
    <svg className="levels-chart" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <line className="levels-chart__axis" x1={4} x2={width - 4} y1={height - axis} y2={height - axis} />
      {levels.map((level, index) => (
        <g key={level.name}>
          <rect
            className={`levels-chart__bar levels-chart__bar--${index}`}
            x={4 + index * band + band * 0.15}
            y={y(level.students)}
            width={band * 0.7}
            height={plotHeight * (level.students / max)}
            rx={3}
          />
          <text className="levels-chart__value" x={4 + index * band + band / 2} y={y(level.students) - 4}>
            {level.students}
          </text>
          <text className="levels-chart__label" x={4 + index * band + band / 2} y={height - 10}>
            {level.name}
          </text>
        </g>
      ))}
      <line x1={4} x2={width - 4} y1={y(goal)} y2={y(goal)} stroke={goalColor} strokeWidth={1.5} strokeDasharray="5 4" />
    </svg>
  );
}
