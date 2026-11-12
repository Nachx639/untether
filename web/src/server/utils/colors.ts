import { stripVTControlCharacters, styleText } from 'node:util';

type Color = 'blue' | 'cyan' | 'gray' | 'green' | 'magenta' | 'red' | 'yellow';

function color(format: Color): (text: string, stream?: NodeJS.WriteStream) => string {
  return (text, stream = process.stdout) => {
    if (!text) return text;
    // Let Node check the destination stream, including NO_COLOR/FORCE_COLOR.
    const styled = styleText(format, text, { stream });
    // Callers may have colored the message for a different destination already.
    if (styled === text) return stripVTControlCharacters(text);

    const open = styled.slice(0, styled.indexOf('m') + 1);
    const close = '\u001b[39m';
    // Node 22.12 does not restore the outer color after a nested color closes.
    // Close/reopen around line breaks as well, so colors do not bleed between lines.
    const content = text
      .split(close)
      .join(open)
      .replace(/\r?\n/g, (newline) => `${close}${newline}${open}`);
    return `${open}${content}${close}`;
  };
}

export const colors = {
  blue: color('blue'),
  cyan: color('cyan'),
  gray: color('gray'),
  green: color('green'),
  magenta: color('magenta'),
  red: color('red'),
  yellow: color('yellow'),
};
