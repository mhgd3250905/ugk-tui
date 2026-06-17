const MAX_TRANSCRIPT_LINES = 30;

export class DriverTranscriptTail {
	private lines: string[] = [];

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

		if (this.lines.length > MAX_TRANSCRIPT_LINES) {
			this.lines = this.lines.slice(-MAX_TRANSCRIPT_LINES);
		}
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
