const MAX_TRANSCRIPT_LINES = 30;

export class DriverTranscriptTail {
	private lines: string[] = [];

	private trim(): void {
		if (this.lines.length > MAX_TRANSCRIPT_LINES) {
			this.lines = this.lines.slice(-MAX_TRANSCRIPT_LINES);
		}
	}

	appendText(text: string): void {
		const parts = text.split(/\r\n|\n|\r/);
		if (parts.length === 0) {
			return;
		}

		if (this.lines.length === 0) {
			this.lines.push("");
		}

		this.lines[this.lines.length - 1] += parts[0];
		for (const part of parts.slice(1)) {
			this.lines.push(part);
		}

		this.trim();
	}

	appendLine(line: string): void {
		this.lines.push(line);
		this.trim();
	}

	toText(): string {
		return this.lines.join("\n").trimEnd();
	}

	toWidgetLines(title: string): string[] {
		const text = this.toText();
		if (!text) {
			return [title, "(no driver output yet)"];
		}
		return [title, ...text.split("\n")];
	}
}
