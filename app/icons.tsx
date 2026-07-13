/* Orchestrator — icon set (ported from the design's icons.js) */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

function S(children: React.ReactNode, props?: P) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      width="1em"
      height="1em"
      style={{ flex: "none" }}
      {...props}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  plus: (p?: P) => S(<><line x1={12} y1={5} x2={12} y2={19} /><line x1={5} y1={12} x2={19} y2={12} /></>, p),
  chart: (p?: P) => S(<><line x1={5} y1={20} x2={5} y2={13} /><line x1={12} y1={20} x2={12} y2={5} /><line x1={19} y1={20} x2={19} y2={9} /></>, p),
  folder: (p?: P) => S(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />, p),
  gear: (p?: P) => S(<><circle cx={12} cy={12} r={3} /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>, p),
  send: (p?: P) => S(<><path d="M7 11l5-5 5 5" /><line x1={12} y1={6} x2={12} y2={18} /></>, p),
  spark: (p?: P) => S(<path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6z" />, p),
  clock: (p?: P) => S(<><circle cx={12} cy={12} r={9} /><path d="M12 7v5l3 2" /></>, p),
  clear: (p?: P) => S(<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v4h4" /></>, p),
  dots: (p?: P) => S(<><circle cx={5} cy={12} r={1} /><circle cx={12} cy={12} r={1} /><circle cx={19} cy={12} r={1} /></>, p),
  chevDown: (p?: P) => S(<path d="M6 9l6 6 6-6" />, p),
  chevUp: (p?: P) => S(<path d="M6 15l6-6 6 6" />, p),
  chevRight: (p?: P) => S(<path d="M9 6l6 6-6 6" />, p),
  toBottom: (p?: P) => S(<><path d="M7 7l5 5 5-5" /><line x1={5} y1={17} x2={19} y2={17} /></>, p),
  x: (p?: P) => S(<><line x1={6} y1={6} x2={18} y2={18} /><line x1={6} y1={18} x2={18} y2={6} /></>, p),
  clip: (p?: P) => S(<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />, p),
  check: (p?: P) => S(<path d="M5 12l5 5 9-11" />, p),
  lock: (p?: P) => S(<><rect x={4} y={11} width={16} height={9} rx={2} /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, p),
  edit: (p?: P) => S(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>, p),
  doc: (p?: P) => S(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>, p),
  github: (p?: P) => S(<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />, p),
  git: (p?: P) => S(<><circle cx={6} cy={6} r={2} /><circle cx={6} cy={18} r={2} /><circle cx={18} cy={9} r={2} /><path d="M18 11a8 8 0 0 1-8 8" /><line x1={6} y1={8} x2={6} y2={16} /></>, p),
  flag: (p?: P) => S(<path d="M5 21V4h12l-2 4 2 4H5" />, p),
  bolt: (p?: P) => S(<path d="M13 2L4 14h7l-1 8 9-12h-7z" />, p),
  moon: (p?: P) => S(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />, p),
  sun: (p?: P) => S(<><circle cx={12} cy={12} r={4} /><line x1={12} y1={2} x2={12} y2={5} /><line x1={12} y1={19} x2={12} y2={22} /><line x1={2} y1={12} x2={5} y2={12} /><line x1={19} y1={12} x2={22} y2={12} /><line x1={4.9} y1={4.9} x2={6.8} y2={6.8} /><line x1={17.2} y1={17.2} x2={19.1} y2={19.1} /><line x1={4.9} y1={19.1} x2={6.8} y2={17.2} /><line x1={17.2} y1={6.8} x2={19.1} y2={4.9} /></>, p),
  external: (p?: P) => S(<><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" /></>, p),
  copy: (p?: P) => S(<><rect x={9} y={9} width={12} height={12} rx={2} /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>, p),
  play: (p?: P) => S(<path d="M7 5l11 7-11 7z" />, p),
  stop: (p?: P) => S(<rect x={6} y={6} width={12} height={12} rx={2} />, p),
  sliders: (p?: P) => S(<><line x1={4} y1={21} x2={4} y2={14} /><line x1={4} y1={10} x2={4} y2={3} /><line x1={12} y1={21} x2={12} y2={12} /><line x1={12} y1={8} x2={12} y2={3} /><line x1={20} y1={21} x2={20} y2={16} /><line x1={20} y1={12} x2={20} y2={3} /><line x1={1} y1={14} x2={7} y2={14} /><line x1={9} y1={8} x2={15} y2={8} /><line x1={17} y1={16} x2={23} y2={16} /></>, p),
  search: (p?: P) => S(<><circle cx={11} cy={11} r={7} /><line x1={21} y1={21} x2={16.65} y2={16.65} /></>, p),
  terminal: (p?: P) => S(<><rect x={3} y={4} width={18} height={16} rx={2} /><path d="M7 9l3 3-3 3" /><line x1={13} y1={15} x2={17} y2={15} /></>, p),
  archive: (p?: P) => S(<><rect x={3} y={4} width={18} height={4} rx={1} /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" /><line x1={10} y1={12} x2={14} y2={12} /></>, p),
  restore: (p?: P) => S(<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></>, p),
};
