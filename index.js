const fs = require("fs");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const ffmpeg = require("fluent-ffmpeg");
const { GoogleAIFileManager, FileState } = require("@google/generative-ai/server");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Setup FFmpeg paths
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Configuration
const VIDEO_DIR = "./video";
const OUTPUT_DIR = "./output";
const API_KEY = "AIzaSyBni_55HwsH-KRd9j8_XhK-PDRReUjtgdE";

// Utility function to wait
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Upload video to Gemini and generate JSON response
const analyzeVideoWithGemini = async (filePath, apiKey) => {
    const fileManager = new GoogleAIFileManager(apiKey);
    const genAI = new GoogleGenerativeAI(apiKey);

    try {
        // Upload the video to Gemini
        const uploadResponse = await fileManager.uploadFile(filePath, {
            mimeType: "video/mp4",
            displayName: path.basename(filePath),
        });

        const fileUri = uploadResponse?.file?.uri;
        if (!fileUri) {
            throw new Error(`Failed to upload video: ${filePath}`);
        }

        const fileId = fileUri.split("/").pop();
        let file = await fileManager.getFile(fileId);

        while (file.state === FileState.PROCESSING) {
            await wait(10000);
            file = await fileManager.getFile(fileId);
        }

        if (file.state === FileState.FAILED) {
            throw new Error(`Processing failed for video: ${filePath}`);
        }

        // Send prompt to Gemini
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `Generate a detailed JSON output with three objects based on the following criteria from the given video content:

Divide the Video into Chapters: Create an object with timestamps as keys and corresponding chapter names as values.
Find Controversial Parts: Identify segments with a minimum length of 10 seconds that could spark debate or controversy, with timestamps as keys and descriptions as values.
Identify Viral Parts: Locate segments with a minimum length of 30 seconds that have high potential to go viral, with timestamps as keys and descriptions as values.
Ensure the output only includes the JSON structure for these three objects, formatted for direct integration into code without extra lines or explanations. Keep it concise and precise.`;

        const result = await model.generateContent([prompt, {
            fileData: {
                fileUri: file.uri,
                mimeType: "video/mp4",
            },
        }]);

        let jsonResponse = result?.response?.text?.();

        // Strip backticks and any "```json" code block formatting
        jsonResponse = jsonResponse.replace(/```json/g, "").replace(/```/g, "").trim();

        console.log(`JSON response: ${jsonResponse}`);

        // Parse the JSON response
        const parsedResponse = JSON.parse(jsonResponse);

        return parsedResponse;
    } catch (error) {
        console.error(`Error analyzing video with Gemini:`, error.message);
        throw error;
    }
};


// Split video based on timestamps
const splitVideoSegments = (filePath, segments, segmentType) => {
    return new Promise((resolve, reject) => {
        const videoName = path.basename(filePath, path.extname(filePath));
        const outputDir = path.join(OUTPUT_DIR, `${videoName}_${segmentType}`);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const segmentPromises = segments.map((segment, index) => {
            return new Promise((segmentResolve, segmentReject) => {
                const outputFileName = `segment_${index + 1}_${segmentType}.mp4`;
                const outputFilePath = path.join(outputDir, outputFileName);

                ffmpeg(filePath)
                    .setStartTime(segment.start_time)
                    .setDuration(segment.duration)
                    .output(outputFilePath)
                    .on("end", () => {
                        console.log(`Segment ${index + 1} (${segmentType}) saved.`);
                        segmentResolve(outputFilePath);
                    })
                    .on("error", (error) => {
                        console.error(`Error processing segment ${index + 1} (${segmentType}):`, error.message);
                        segmentReject(error);
                    })
                    .run();
            });
        });

        Promise.all(segmentPromises)
            .then(resolve)
            .catch(reject);
    });
};

// Main function to process the video
// Convert chapters object to an array of segments
const processChapters = (chapters) => {
    const chapterEntries = Object.entries(chapters);
    const segments = [];

    for (let i = 0; i < chapterEntries.length; i++) {
        const [startTime, chapterName] = chapterEntries[i];
        const [nextStartTime] = chapterEntries[i + 1] || []; // Get next chapter's start time
        const duration = nextStartTime
            ? calculateDuration(startTime, nextStartTime) // Calculate duration
            : undefined; // Leave undefined for the last chapter

        segments.push({
            start_time: startTime,
            duration,
            chapter_name: chapterName,
        });
    }

    return segments;
};

// Helper function to calculate duration between two timestamps
const calculateDuration = (start, end) => {
    const toSeconds = (time) => {
        const [minutes, seconds] = time.split(":").map(Number);
        return minutes * 60 + seconds;
    };

    const startSeconds = toSeconds(start);
    const endSeconds = toSeconds(end);
    return endSeconds - startSeconds;
};

// Main function to process the video
const processVideo = async () => {
    try {
        // Ensure output directory exists
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        // Get video file
        const videoFiles = fs.readdirSync(VIDEO_DIR).filter(file => file.endsWith(".mp4"));
        if (videoFiles.length === 0) throw new Error("No video files found in the video directory.");
        const videoFilePath = path.join(VIDEO_DIR, videoFiles[0]);

        console.log(`Processing video: ${videoFilePath}`);

        // Analyze video with Gemini
        const analysis = await analyzeVideoWithGemini(videoFilePath, API_KEY);

        // Split video into segments
        if (analysis.chapters) {
            console.log("Splitting chapters...");
            const chapterSegments = processChapters(analysis.chapters); // Convert chapters to array
            await splitVideoSegments(videoFilePath, chapterSegments, "chapters");
        }
        if (analysis.controversial_parts) {
            console.log("Splitting controversial parts...");
            await splitVideoSegments(videoFilePath, analysis.controversial_parts, "controversial");
        }
        if (analysis.viral_parts) {
            console.log("Splitting viral parts...");
            await splitVideoSegments(videoFilePath, analysis.viral_parts, "viral");
        }

        console.log("Video processing completed.");
    } catch (error) {
        console.error("Error processing video:", error.message);
    }
};

// Start processing
processVideo();
