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
const API_KEY = "AIzaSyDgflhQJ2v0VxGCpDdbtP6wBiOX92oQgeg";

// Utility function to wait
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Preprocess JSON to handle malformed keys
const preprocessJsonResponse = (rawResponse) => {
    try {
        return JSON.parse(rawResponse);
    } catch (error) {
        const fixedResponse = rawResponse.replace(/:\s*\"(.*?)\":/g, ': "$1",');
        return JSON.parse(fixedResponse);
    }
};

// Upload video to Gemini and generate JSON response
const analyzeVideoWithGemini = async (filePath, apiKey) => {
    console.log("Starting video analysis with Gemini...");
    const fileManager = new GoogleAIFileManager(apiKey);
    const genAI = new GoogleGenerativeAI(apiKey);

    try {
        const uploadResponse = await fileManager.uploadFile(filePath, {
            mimeType: "video/mp4",
            displayName: path.basename(filePath),
        });

        console.log("Video uploaded successfully.");

        const fileUri = uploadResponse?.file?.uri;
        if (!fileUri) {
            throw new Error(`Failed to upload video: ${filePath}`);
        }

        const fileId = fileUri.split("/").pop();
        let file = await fileManager.getFile(fileId);

        console.log("Checking file processing status...");
        while (file.state === FileState.PROCESSING) {
            console.log("File is processing...");
            await wait(10000);
            file = await fileManager.getFile(fileId);
        }

        if (file.state === FileState.FAILED) {
            throw new Error(`Processing failed for video: ${filePath}`);
        }

        console.log("File processing completed.");

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt =  `you are a great video viewer. Analyze the video content and generate a detailed JSON structure divided into three sections: Chapters, Controversial Parts, and Viral Parts. Follow these steps:

        1. Divide the Video into Chapters:
        - Segment the video into logical chapters based on content flow.
        - Use timestamps formatted as "MM:SS" as keys to denote the starting time of each chapter.
        - For each chapter, include:
          - "start": The chapter's starting timestamp.
          - "end": The chapter's ending timestamp.
          - "name": A concise, meaningful title summarizing the chapter.
        
        2. Identify Controversial Parts:
        - Detect video segments likely to generate debate or disagreement.
        - Each segment must be at least 10 seconds long.
        - For each controversial segment, include:
          - "start": Starting timestamp.
          - "end": Ending timestamp.
          - "description": A brief explanation of the controversy.
        
        3. Identify Viral Parts:
        - Highlight engaging or impactful moments with viral potential.
        - Each segment must be at least 30 seconds long.
        - For each viral segment, include:
          - "start": Starting timestamp.
          - "end": Ending timestamp.
          - "description": A brief explanation of why the segment has viral potential.
        
        Output Requirements:
        - Return a JSON object with three keys: "chapters".
        - Ensure timestamps and descriptions are accurate, concise, and descriptive.
        Example JSON Format:
        {
          "chapters": {
            "00:00:00": {"start": "00:00:00", "end": "00:05:00", "name": "Introduction"},
            "00:05:01": {"start": "00:05:01", "end": "00:12:00", "name": "Deep Dive into Key Concepts"}
          }
        }
        Additional Notes:- Use meaningful and engaging titles for chapters and clear, concise descriptions for controversial and viral parts.
        - Skip segments with minor or negligible significance.
        - Prioritize readability and coherence in the output.`;

        const result = await model.generateContent([prompt, {
            fileData: {
                fileUri: file.uri,
                mimeType: "video/mp4",
            },
        }]);

        console.log("Received response from Gemini.");

        let jsonResponse = result?.response?.text?.();

        jsonResponse = jsonResponse.replace(/```json/g, "").replace(/```/g, "").trim();

        console.log(`JSON response: ${jsonResponse}`);

        const parsedResponse = preprocessJsonResponse(jsonResponse);

        return parsedResponse;
    } catch (error) {
        console.error(`Error analyzing video with Gemini:`, error.message);
        throw error;
    }
};

// Convert objects to an array of segments
const processSegments = (segmentsObject) => {
    console.log("Processing segments...");
    return Object.entries(segmentsObject).map(([start, details]) => {
        const { end, ...rest } = details;
        const duration = calculateDuration(start, end);
        return { start_time: start, duration, ...rest };
    });
};

// Split video based on timestamps
const verifyFileIntegrity = (filePath) => {
    console.log(`Verifying file integrity for: ${filePath}`);
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
};

const splitVideoSegments = (filePath, segments, segmentType) => {
    console.log(`Splitting video into ${segmentType} segments...`);
    const videoName = path.basename(filePath, path.extname(filePath));
    const outputDir = path.join(OUTPUT_DIR, `${videoName}_${segmentType}`);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const processSegment = (segment, index) => {
        return new Promise((resolve, reject) => {
            const outputFileName = `segment_${index + 1}_${segmentType}.mp4`;
            const outputFilePath = path.join(outputDir, outputFileName);

            ffmpeg(filePath)
                .setStartTime(segment.start_time)
                .setDuration(segment.duration)
                .output(outputFilePath)
                .on("start", (commandLine) => {
                    console.log(`FFmpeg process started: ${commandLine}`);
                })
                .on("end", () => {
                    console.log(`Finished processing segment ${index + 1} (${segmentType}).`);
                    if (verifyFileIntegrity(outputFilePath)) {
                        console.log(`Segment ${index + 1} (${segmentType}) saved and verified.`);
                        resolve(outputFilePath);
                    } else {
                        console.error(`Segment ${index + 1} (${segmentType}) is corrupted.`);
                        reject(new Error("File corrupted"));
                    }
                })
                .on("error", (err) => {
                    console.error(`Error processing segment ${index + 1} (${segmentType}):`, err.message);
                    reject(err);
                })
                .run();
        });
    };

    const processAllSegments = async () => {
        const results = [];
        for (let i = 0; i < segments.length; i++) {
            try {
                const result = await processSegment(segments[i], i);
                results.push(result);
            } catch (error) {
                console.error(`Skipping segment ${i + 1} due to error:`, error.message);
            }
        }
        return results;
    };

    return processAllSegments();
};

const calculateDuration = (start, end) => {
    console.log(`Calculating duration: Start ${start}, End ${end}`);
    const toSeconds = (time) => {
        if (!time || !time.includes(":")) {
            throw new Error(`Invalid time format: "${time}". Expected "MM:SS".`);
        }

        const [minutes, seconds] = time.split(":").map(Number);
        if (isNaN(minutes) || isNaN(seconds)) {
            throw new Error(`Invalid time values: "${time}". Expected numeric values.`);
        }

        return minutes * 60 + seconds;
    };

    try {
        const startSeconds = toSeconds(start);
        const endSeconds = toSeconds(end);
        const duration = endSeconds - startSeconds;
        console.log(`Calculated duration: ${duration} seconds.`);
        return duration;
    } catch (error) {
        console.error(`Error calculating duration: ${error.message}`);
        throw error; // Re-throw the error to handle it upstream
    }
};

const stitchSelectedSegments = (segmentPaths, indices, outputFilePath) => {
    return new Promise((resolve, reject) => {
        const ffmpegCommand = ffmpeg();
        const selectedSegmentPaths = segmentPaths.filter((_, idx) => indices.includes(idx + 1));

        if (selectedSegmentPaths.length === 0) {
            console.log(`No segments selected for stitching. Skipping ${outputFilePath}`);
            return resolve(null);
        }

        selectedSegmentPaths.forEach((segmentPath) => {
            ffmpegCommand.input(segmentPath);
        });

        ffmpegCommand
            .on("end", () => {
                console.log(`Stitched video saved to ${outputFilePath}`);
                resolve(outputFilePath);
            })
            .on("error", (error) => {
                console.error(`Error stitching segments:`, error.message);
                reject(error);
            })
            .mergeToFile(outputFilePath, OUTPUT_DIR);
    });
};

const processVideo = async () => {
    try {
        console.log("Starting video processing...");
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        const videoFiles = fs.readdirSync(VIDEO_DIR).filter(file => file.endsWith(".mp4"));
        if (videoFiles.length === 0) throw new Error("No video files found in the video directory.");
        const videoFilePath = path.join(VIDEO_DIR, videoFiles[0]);

        console.log(`Processing video: ${videoFilePath}`);

        const analysis = await analyzeVideoWithGemini(videoFilePath, API_KEY);
        if (analysis.chapters) {
            console.log("Splitting chapters...");
            const chapterSegments = processSegments(analysis.chapters);
            await splitVideoSegments(videoFilePath, chapterSegments, "chapters");
        }

        if (analysis.viral_parts) {
            console.log("Splitting viral parts...");
            const viralSegments = processSegments(analysis.viral_parts);
            await splitVideoSegments(videoFilePath, viralSegments, "viral");
        }

        const chapterDir = path.join(OUTPUT_DIR, "output_chapters");
                const stitchOutputDir = OUTPUT_DIR; // Define stitchOutputDir
                if (!fs.existsSync(chapterDir)) {
                    throw new Error(`Chapter directory does not exist: ${chapterDir}`);
                }
        
                const chapterIndices = [1, 3,11];
                const chapterFiles = fs.readdirSync(chapterDir).filter(file => file.endsWith(".mp4"));
                const chapterPaths = chapterFiles.map(file => path.join(chapterDir, file));

                await stitchSelectedSegments(
                    chapterPaths,
                    chapterIndices,
                    path.join(stitchOutputDir, "chapters_stitched.mp4")
                );
        
                console.log("Video processing and stitching completed.");
            } catch (error) {
                console.error("Error processing video:", error.message);
            }
};

processVideo();
