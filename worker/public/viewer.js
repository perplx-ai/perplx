async function load() {
	const res = await fetch("/api/sessions/" + SESSION_ID);
	if (!res.ok) { document.getElementById("root").innerHTML = "<p>Failed to load.</p>"; return; }
	const data = await res.json();
	render(data.entries);
}

function escapeHtml(s) {
	return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function renderMarkdown(text) {
	try { return marked.parse(text); } catch { return "<p>" + escapeHtml(text) + "</p>"; }
}

function toolArgsPreview(args) {
	if (!args) return "";
	const keys = Object.keys(args);
	if (keys.length === 0) return "";

	const parts = keys.slice(0, 3).map(k => {
		const v = args[k];
		if (typeof v === "string") return k + '="' + (v.length > 40 ? v.slice(0, 40) + "…" : v) + '"';
		if (typeof v === "number" || typeof v === "boolean") return k + "=" + v;
		return null;
	}).filter(Boolean);

	if (keys.length > 3) parts.push("…");
	return parts.join("  ");
}

function renderCollapsible(cls, headerCls, bodyCls, label, body) {
	return '<div class="' + cls + '">'
		+ '<div class="' + headerCls + '" onclick="this.parentElement.classList.toggle(\'open\')">'
		+ '<span class="tool-chevron">▶</span>'
		+ label
		+ '</div>'
		+ '<div class="' + bodyCls + '"><pre><code>' + body + '</code></pre></div>'
		+ '</div>';
}

function renderBlock(block) {
	if (block.type === "text")
		return renderMarkdown(block.text);

	if (block.type === "thinking")
		return '<div class="thinking">' + escapeHtml(block.thinking || "") + '</div>';

	if (block.type === "toolCall") {
		const preview = toolArgsPreview(block.arguments);
		const label = '<span class="tool-name">' + escapeHtml(block.name) + '</span>'
			+ '<span class="tool-args-preview">' + escapeHtml(preview) + '</span>';
		return renderCollapsible("tool-call", "tool-header", "tool-body", label, escapeHtml(JSON.stringify(block.arguments, null, 2)));
	}

	if (block.type === "toolResult") {
		const text = block.content?.filter(c => c.type === "text").map(c => c.text).join("\n") || "";
		const label = '<span class="tool-result-label">Output</span>';
		return renderCollapsible("tool-result", "tool-result-header", "tool-result-body", label, escapeHtml(text.slice(0, 2000)));
	}

	return "";
}

function renderMessage(msg) {
	if (msg.role === "user") {
		const text = typeof msg.content === "string" ? msg.content : (msg.content?.[0]?.text ?? "");
		return '<div class="message"><div class="role user">User</div><div class="body">' + renderMarkdown(text) + '</div></div>';
	}

	if (msg.role === "assistant") {
		const content = (msg.content || []).map(renderBlock).join("");
		return '<div class="message"><div class="role assistant">Assistant</div><div class="body">' + content + '</div></div>';
	}

	return "";
}

function render(entries) {
	const root = document.getElementById("root");
	const html = entries
		.filter(e => e.type === "message" && e.message)
		.map(e => renderMessage(e.message))
		.join("");
	root.innerHTML = html || "<p>Empty session.</p>";
	document.querySelectorAll("pre code").forEach(el => hljs.highlightElement(el));
}

load();
