export const wideTable = [
	'| ' + Array.from({ length: 12 }, (_, i) => `항목 ${i + 1}`).join(' | ') + ' |',
	'| ' +
		Array.from({ length: 12 }, (_, i) => (i === 1 ? ':---:' : i === 2 ? '---:' : ':---')).join(
			' | '
		) +
		' |',
	'| [[table-reference|표 참고]] | **가운데 값** | 42 | 코드 `점검` | 근거[^table] | 값 6 | 값 7 | 값 8 | 값 9 | 값 10 | 값 11 | 마지막 열 값 |',
	'| ' + Array.from({ length: 12 }, (_, i) => `점검 ${i + 1}`).join(' | ') + ' |'
].join('\n');

export const readingTableContent = `## 넓은 점검 표

[표 앞 링크](#section-1)

${wideTable}

[표 뒤 링크](#section-2)

## 작은 표와 빈 표

| 항목 | 내용 |
| --- | --- |
| 이름 | 가상 자료 |

| 항목 | 내용 |
| --- | --- |

[^table]: 표의 가상 점검 근거
`;
