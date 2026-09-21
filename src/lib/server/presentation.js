import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { posix } from 'node:path';

const elements = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));

export async function extractPresentation(bytes) {
	const zip = await JSZip.loadAsync(bytes);
	async function xml(path) {
		const file = zip.file(path);
		if (!file) throw new Error('Missing presentation part');
		const text = await file.async('string');
		if (text.length > 20_000_000 || /<!DOCTYPE|<!ENTITY/i.test(text))
			throw new Error('Unsupported presentation XML');
		const fail = () => {
			throw new Error('Invalid presentation XML');
		};
		return new DOMParser({
			errorHandler: { warning: fail, error: fail, fatalError: fail }
		}).parseFromString(text, 'application/xml');
	}
	const presentation = await xml('ppt/presentation.xml');
	if (presentation.documentElement.localName !== 'presentation')
		throw new Error('Invalid presentation');
	const relationships = elements(await xml('ppt/_rels/presentation.xml.rels'), 'Relationship');
	const slides = [];
	for (const [index, slide] of elements(presentation, 'sldId').entries()) {
		const relationshipId = Array.from(slide.attributes).find(
			(attribute) =>
				attribute.localName === 'id' && attribute.namespaceURI?.endsWith('/relationships')
		)?.value;
		const relationship = relationships.find((item) => item.getAttribute('Id') === relationshipId);
		if (
			!relationship ||
			relationship.getAttribute('TargetMode') === 'External' ||
			!relationship.getAttribute('Type').endsWith('/slide')
		)
			throw new Error('Invalid slide relationship');
		const target = relationship.getAttribute('Target');
		const path = posix.normalize(
			target.startsWith('/') ? target.slice(1) : posix.join('ppt', target)
		);
		if (!path.startsWith('ppt/') || !path.endsWith('.xml')) throw new Error('Invalid slide path');
		const document = await xml(path);
		if (document.documentElement.localName !== 'sld') throw new Error('Invalid slide');
		const paragraphs = elements(document, 'p')
			.map((paragraph) => {
				function text(node) {
					if (node.localName === 't') return node.textContent || '';
					if (node.localName === 'br') return '\n';
					return Array.from(node.childNodes || [])
						.map(text)
						.join('');
				}
				return text(paragraph).trim();
			})
			.filter(Boolean);
		if (paragraphs.length) slides.push(`## 슬라이드 ${index + 1}\n\n${paragraphs.join('\n')}`);
	}
	return slides.join('\n\n');
}
