export interface ToggleLineCommentsResult {
    text: string;
    selectionStart: number;
    selectionEnd: number;
}

export function toggleLineComments(
    text: string,
    selectionStart: number,
    selectionEnd: number,
): ToggleLineCommentsResult | null {
    const blockStart = text.lastIndexOf('\n', selectionStart - 1) + 1;
    const adjustedEnd = selectionEnd > selectionStart && text[selectionEnd - 1] === '\n'
        ? selectionEnd - 1
        : selectionEnd;
    const nextLineStart = text.indexOf('\n', adjustedEnd);
    const blockEnd = nextLineStart === -1 ? text.length : nextLineStart;
    const originalLines = text.slice(blockStart, blockEnd).split('\n');
    const nonEmptyLines = originalLines.filter(line => line.trim());
    if (nonEmptyLines.length === 0) return null;

    const removeComments = nonEmptyLines.every(line => /^\s*#/.test(line));
    const updatedLines = originalLines.map(line => {
        if (!line.trim()) return line;
        const indent = line.match(/^\s*/)?.[0] || '';
        const content = line.slice(indent.length);
        if (removeComments) return indent + content.replace(/^# ?/, '');
        return content.startsWith('#') ? line : `${indent}# ${content}`;
    });
    const lineOffsets: number[] = [];
    let nextLineOffset = 0;
    updatedLines.forEach(line => {
        lineOffsets.push(nextLineOffset);
        nextLineOffset += line.length + 1;
    });

    const mapSelection = (position: number) => {
        const relativePosition = Math.max(0, Math.min(position - blockStart, blockEnd - blockStart));
        const prefix = text.slice(blockStart, blockStart + relativePosition);
        const lineIndex = prefix.split('\n').length - 1;
        const lineStart = prefix.lastIndexOf('\n') + 1;
        const column = relativePosition - lineStart;
        const oldLine = originalLines[lineIndex] || '';
        const newLine = updatedLines[lineIndex] || '';
        const indentLength = oldLine.match(/^\s*/)?.[0].length || 0;
        let mappedColumn = column;

        if (removeComments) {
            const comment = oldLine.slice(indentLength).match(/^# ?/)?.[0] || '';
            if (column > indentLength && comment) {
                mappedColumn = Math.max(indentLength, column - comment.length);
            }
        } else if (oldLine.trim() && !/^\s*#/.test(oldLine) && column >= indentLength) {
            mappedColumn += 2;
        }

        return blockStart + (lineOffsets[lineIndex] || 0) + Math.min(mappedColumn, newLine.length);
    };

    const updatedBlock = updatedLines.join('\n');
    return {
        text: text.slice(0, blockStart) + updatedBlock + text.slice(blockEnd),
        selectionStart: mapSelection(selectionStart),
        selectionEnd: mapSelection(selectionEnd),
    };
}
