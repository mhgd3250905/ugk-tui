import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const failures = [];

function fail(assertion, expected, actual, hint) {
  failures.push({ assertion, expected, actual, hint });
}

// Read runtime input
const taskInput = JSON.parse(process.env.TASK_INPUT || "{}");
const taskOutputDir = process.env.TASK_OUTPUT_DIR || ".";

const url = taskInput.url;
const page = taskInput.page || 1;

// Validate url is provided
if (!url) {
  fail("url is provided", "non-empty url string", "undefined or empty", "url is required");
}

// Construct output file path
const outputFile = join(taskOutputDir, `bilibili_videos_page${page}.json`);

// Check file exists
if (!existsSync(outputFile)) {
  fail("output file exists", outputFile, "file not found", `Worker should produce ${outputFile}`);
} else {
  // Parse JSON
  let data;
  try {
    const content = readFileSync(outputFile, "utf-8");
    data = JSON.parse(content);
  } catch (e) {
    fail("output is valid JSON", "parseable JSON", e.message, "File should contain valid JSON");
    console.log(JSON.stringify(failures, null, 2));
    process.exit(1);
  }

  // Check required fields
  const requiredFields = ["url", "uid", "page", "extract_time", "video_count", "videos"];
  for (const field of requiredFields) {
    if (!(field in data)) {
      fail(`JSON has field "${field}`, `field "${field}" present`, "missing", `Missing required field: ${field}`);
    }
  }

  // Check videos is array
  if (!Array.isArray(data.videos)) {
    fail("videos is array", "Array", typeof data.videos, "videos field should be an array");
  } else {
    // Check videos not empty
    if (data.videos.length === 0) {
      fail("videos array not empty", "non-empty array", "empty array", "Page should have at least one video");
    }

    // Check video_count matches actual count
    if (data.video_count !== data.videos.length) {
      fail(
        "video_count matches videos.length",
        data.videos.length,
        data.video_count,
        "video_count should match actual video count"
      );
    }

    // Check each video has required fields and valid time format
    for (let i = 0; i < data.videos.length; i++) {
      const video = data.videos[i];
      const videoFields = ["title", "link", "time"];

      for (const field of videoFields) {
        if (!(field in video)) {
          fail(
            `video[${i}] has field "${field}"`,
            `field "${field}" present`,
            "missing",
            `Video at index ${i} missing field: ${field}`
          );
        }
      }

      // Check time is absolute (not relative)
      if (video.time) {
        // Reject relative time patterns
        const relativePatterns = [/前/, /昨天/, /前天/, /今天/, /刚才/];
        for (const pattern of relativePatterns) {
          if (pattern.test(video.time)) {
            fail(
              `video[${i}].time is absolute`,
              "absolute time (YYYY-MM-DD HH:MM:SS)",
              video.time,
              "Time should be converted from relative to absolute format"
            );
            break;
          }
        }

        // Check time format (lenient - just needs to parse to date)
        const timeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
        if (!timeRegex.test(video.time)) {
          // Try more lenient check - at least has year-month-day
          const datePart = video.time.split(" ")[0];
          const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
          if (!dateRegex.test(datePart)) {
            fail(
              `video[${i}].time has valid date format`,
              "YYYY-MM-DD HH:MM:SS or YYYY-MM-DD",
              video.time,
              "Time should contain parseable date"
            );
          }
        }
      }

      // Check link format
      if (video.link && !video.link.includes("bilibili.com/video/")) {
        fail(
          `video[${i}].link is bilibili video link`,
          "contains bilibili.com/video/",
          video.link,
          "Link should be a bilibili video URL"
        );
      }
    }
  }

  // Check uid is valid (numeric string)
  if (data.uid) {
    if (!/^\d+$/.test(String(data.uid))) {
      fail("uid is numeric", "numeric string", String(data.uid), "uid should be a numeric string");
    }
  }

  // Check page matches
  if (data.page !== Number(page)) {
    fail("page matches input", Number(page), data.page, "page field should match input page");
  }
}

// Output results
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
} else {
  console.log("PASS");
  process.exit(0);
}