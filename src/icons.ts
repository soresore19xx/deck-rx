export { svgB64 } from './dialDisplay.js';

export function tuneSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="72" height="72">
    <rect width="72" height="72" fill="#1a1a2e"/>
    <line x1="36" y1="8" x2="36" y2="40" stroke="#00cc44" stroke-width="3"/>
    <line x1="36" y1="40" x2="20" y2="56" stroke="#00cc44" stroke-width="3"/>
    <line x1="36" y1="40" x2="52" y2="56" stroke="#00cc44" stroke-width="3"/>
    <ellipse cx="36" cy="28" rx="14" ry="6" fill="none" stroke="#00cc44" stroke-width="2" opacity="0.7"/>
    <ellipse cx="36" cy="22" rx="22" ry="9" fill="none" stroke="#00cc44" stroke-width="1.5" opacity="0.4"/>
  </svg>`;
}

export function knobSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" width="72" height="72">
    <rect width="72" height="72" fill="#1a1a2e"/>
    <circle cx="36" cy="36" r="28" fill="#2a2a4a" stroke="#00cc44" stroke-width="2"/>
    <circle cx="36" cy="36" r="18" fill="#1a1a3a"/>
    <line x1="36" y1="36" x2="36" y2="12" stroke="#00FF41" stroke-width="3" stroke-linecap="round"/>
  </svg>`;
}

const BLUE = '#00aaff';

export interface OptionsPanelRow { label: string; value: string; }

export function optionsPanelSvg(rows: OptionsPanelRow[], selectedRow = -1, editMode = false, borderSide: 'left' | 'right' | 'center' | 'none' = 'none'): string {
  const rowH = 17;
  const startY = 17;
  const items = rows.map(({ label, value }, i) => {
    const y = startY + i * rowH;
    const isSelected = i === selectedRow;
    const isEdit = isSelected && editMode;
    const accent = isEdit ? '#ffaa55' : BLUE;
    const bg  = isSelected ? `<rect x="0" y="${y - 14}" width="200" height="${rowH}" fill="#222222"/>` : '';
    const bar = isSelected ? `<rect x="0" y="${y - 14}" width="3" height="${rowH}" fill="${accent}"/>` : '';
    const valueColor = isSelected && !isEdit ? '#ffee00' : 'white';
    return `${bg}${bar}
<text x="8" y="${y}" fill="${isSelected ? accent : 'white'}" font-size="12" font-family="monospace">${label}</text>
<text x="192" y="${y}" fill="${valueColor}" font-size="14" font-family="monospace" text-anchor="end">${value}</text>`;
  }).join('\n');
  const C = '#888888';
  const vertLines = borderSide === 'left'  ? `<line x1="0" y1="0" x2="0" y2="92" stroke="${C}" stroke-width="1"/>`
                  : borderSide === 'right' ? `<line x1="199" y1="0" x2="199" y2="92" stroke="${C}" stroke-width="1"/>`
                  : '';
  const border = borderSide === 'none' ? '' : [
    `<line x1="0" y1="0" x2="200" y2="0" stroke="${C}" stroke-width="1"/>`,
    `<line x1="0" y1="91" x2="200" y2="91" stroke="${C}" stroke-width="1"/>`,
    vertLines,
  ].join('');
  return `<svg width="200" height="92" xmlns="http://www.w3.org/2000/svg">
<rect width="200" height="92" fill="#000000"/>
<line x1="80" y1="6" x2="80" y2="87" stroke="#2a2a2a" stroke-width="1"/>
${items}
${border}
</svg>`;
}
