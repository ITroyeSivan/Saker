/** Parse a protocol JSON response with a bounded, useful error message. */
export function parseJsonResponse(value, label) {
	const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
	try {
		return JSON.parse(text);
	} catch (error) {
		const preview = text.replace(/\s+/g, " ").slice(0, 180);
		throw new Error(`${label}返回非 JSON：${error.message}${preview ? `；响应预览：${preview}` : ""}`);
	}
}
