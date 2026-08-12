/**
 * AI Tag Suggester for Zotero (Gemini Flash Edition)
 * @author ellievoid (adapted for Google Gemini API)
 * @usage Suggests and applies tags to selected item using Gemini Flash based on existing library tags
 */

/************* Configurations Start *************/
// Gemini Configuration
let apiKey = " "; // Replace with your Gemini API Key
let modelName = "gemini-3.5-flash-lite"; // Recommended Flash model identifier

// Full text settings
let maxFullTextLength = 12000;
let includeFullText = true; // Set to false to use metadata-only
let aiTemperature = 0.1; // Temperature: 0.1 - Low for consistent, deterministic tag selection
/************* Configurations End *************/

if (!item) return;

// Helper function to get full text from web snapshot
function getFullTextFromSnapshot(attachment) {
    try {
        if (!attachment || attachment.attachmentMIMEType !== 'text/html') return null;
        
        const filePath = attachment.getFilePath();
        if (!filePath) return null;
        
        // Read HTML file
        const file = Components.classes["@mozilla.org/file/local;1"]
                             .createInstance(Components.interfaces.nsIFile);
        file.initWithPath(filePath);
        
        if (!file.exists()) return null;
        
        const inputStream = Components.classes["@mozilla.org/network/file-input-stream;1"]
                                     .createInstance(Components.interfaces.nsIFileInputStream);
        inputStream.init(file, -1, -1, 0);
        
        const scriptableStream = Components.classes["@mozilla.org/scriptableinputstream;1"]
                                         .createInstance(Components.interfaces.nsIScriptableInputStream);
        scriptableStream.init(inputStream);
        
        let htmlContent = "";
        let available = scriptableStream.available();
        while (available > 0) {
            htmlContent += scriptableStream.read(available);
            available = scriptableStream.available();
        }
        
        scriptableStream.close();
        inputStream.close();
        
        // Simple HTML text extraction (remove tags)
        const textContent = htmlContent
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // Remove scripts
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')   // Remove styles
            .replace(/<[^>]*>/g, ' ')                          // Remove HTML tags
            .replace(/\s+/g, ' ')                              // Normalize whitespace
            .trim();
        
        return textContent;
    } catch (e) {
        return null;
    }
}

let progressWindow = undefined;
let itemProgress = undefined;

try {
    // Check if this is an attachment itself or a regular item
    const isAttachment = item.isAttachment();
    const isRegular = item.isRegularItem() && item.isTopLevelItem();
    
    if (!isRegular && !isAttachment) {
        return;
    }
    
    // If this is an attachment, get the parent item
    let targetItem = item;
    if (isAttachment) {
        const parentID = item.parentID;
        if (parentID) {
            targetItem = Zotero.Items.get(parentID);
        } else {
            return;
        }
    }
    
    // Now use targetItem for everything
    const shortTitle = targetItem.getField('title').length > 50 ? 
        targetItem.getField('title').substring(0, 50) + "..." : 
        targetItem.getField('title');
    
    progressWindow = new Zotero.ProgressWindow({
        "closeOnClick": true,
    });
    progressWindow.addDescription(shortTitle);
    itemProgress = new progressWindow.ItemProgress();
    itemProgress.setText("Getting tags...");
    progressWindow.show();

    // Get all library tags (excluding those starting with '_')
    const libraryID = targetItem.libraryID;
    
    let allTagsData;
    try {
        allTagsData = await Zotero.Tags.getAll(libraryID);
    } catch (e) {
        const allItems = await Zotero.Items.getAll(libraryID, true);
        const tagSet = new Set();
        
        for (const libItem of allItems) {
            if (libItem.isRegularItem()) {
                const itemTags = libItem.getTags();
                for (const tag of itemTags) {
                    if (tag.tag) {
                        tagSet.add(tag.tag);
                    }
                }
            }
        }
        allTagsData = Array.from(tagSet).map(tag => ({ tag }));
    }
    
    const availableTags = allTagsData
        .map(tagObj => tagObj.tag)
        .filter(tagName => tagName && typeof tagName === 'string')
        .filter(tagName => !tagName.startsWith('_'))
        .sort();

    if (availableTags.length === 0) {
        throw new Error(`No available tags found in library. Library ID: ${libraryID}`);
    }

    itemProgress.setProgress(30);
    itemProgress.setText("Extracting text...");

    let fullText = "";
    if (includeFullText) {
        let attachmentsToProcess = [];
        
        if (isAttachment) {
            attachmentsToProcess = [item];
        } else {
            let attachmentIDs = targetItem.getAttachments();
            
            if (attachmentIDs.length === 0) {
                itemProgress.setText("⏳ Waiting for PDF...");
                for (let i = 0; i < 10; i++) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    attachmentIDs = targetItem.getAttachments();
                    if (attachmentIDs.length > 0) {
                        itemProgress.setText(`✅ Found ${attachmentIDs.length} file(s)`);
                        await new Promise(resolve => setTimeout(resolve, 500));
                        break;
                    }
                }
            }
            
            attachmentsToProcess = attachmentIDs.map(id => Zotero.Items.get(id));
        }
        
        for (const attachment of attachmentsToProcess) {
            if (attachment.isPDFAttachment()) {
                itemProgress.setText("📄 Processing PDF...");
                
                try {
                    const filePath = await attachment.getFilePathAsync();
                    if (!filePath) continue;
                    
                    const file = Components.classes["@mozilla.org/file/local;1"]
                                          .createInstance(Components.interfaces.nsIFile);
                    file.initWithPath(filePath);
                    
                    if (!file.exists()) continue;
                    
                    itemProgress.setText("📄 Extracting...");
                    const pdfText = await attachment.attachmentText;
                    
                    if (pdfText && pdfText.length > 100) {
                        fullText = pdfText;
                        itemProgress.setText("✅ Text extracted");
                        await new Promise(resolve => setTimeout(resolve, 500));
                        break;
                    }
                } catch (e) {
                    itemProgress.setText("⚠️ Extraction failed");
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } else if (attachment.attachmentMIMEType === 'text/html') {
                const snapshotText = getFullTextFromSnapshot(attachment);
                if (snapshotText && snapshotText.length > 100) {
                    fullText = snapshotText;
                    itemProgress.setText("✅ Snapshot extracted");
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        }
        
        if (fullText.length > maxFullTextLength) {
            fullText = fullText.substring(0, maxFullTextLength) + "...[truncated]";
        }
    }

    itemProgress.setProgress(50);
    itemProgress.setText("Analyzing with Gemini...");

    const title = targetItem.getField('title') || '';
    const abstractNote = targetItem.getField('abstractNote') || '';
    const creators = targetItem.getCreators().map(creator => 
        (creator.firstName + ' ' + creator.lastName).trim()
    ).join('; ');
    const itemType = targetItem.itemType || '';
    const publicationTitle = targetItem.getField('publicationTitle') || '';
    const date = targetItem.getField('date') || '';
    const currentTags = targetItem.getTags().map(tag => tag.tag);
    const url = targetItem.getField('url') || '';
    const doi = targetItem.getField('DOI') || '';
    const extra = targetItem.getField('extra') || '';

    let promptText = `Analyze this document and suggest relevant tags strictly from the available list provided below.

DOCUMENT:
Title: ${title}
Authors: ${creators}
Type: ${itemType}
Publication: ${publicationTitle}
Date: ${date}
Abstract: ${abstractNote}
Current Tags: ${currentTags.join(', ')}
DOI: ${doi}
URL: ${url}
Extra: ${extra}`;

    if (fullText.length > 0) {
        promptText += `\n\nFULL TEXT CONTENT:\n${fullText}`;
    }

    promptText += `\n\nAVAILABLE TAGS TO CHOOSE FROM:\n${availableTags.join(', ')}\n\nPlease suggest up to 8 relevant tags. ONLY select tags that exist exact-match in the available list above.`;

    // Corrected Schema Definition without strict enum constraints
    const jsonSchema = {
        type: "OBJECT",
        properties: {
            tags: {
                type: "ARRAY",
                description: "List of suggested tags from the available tags list",
                items: {
                    type: "STRING"
                }
            },
            reasoning: {
                type: "STRING",
                description: "Brief explanation of why these tags were chosen"
            }
        },
        required: ["tags", "reasoning"]
    };

    const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    const response = await fetch(geminiEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            systemInstruction: {
                parts: [{ text: "You are a research librarian helping categorize academic documents. Suggest ONLY tags that exist in the provided available tags list." }]
            },
            contents: [
                {
                    role: "user",
                    parts: [{ text: promptText }]
                }
            ],
            generationConfig: {
                temperature: aiTemperature,
                responseMimeType: "application/json",
                responseSchema: jsonSchema
            }
        })
    });

    if (!response.ok) {
        let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
        try {
            const errorData = await response.json();
            errorMessage += ` - ${errorData.error?.message || ''}`;
        } catch (e) {}
        throw new Error(`Gemini API error: ${errorMessage}`);
    }

    const result = await response.json();
    const rawContent = result.candidates[0].content.parts[0].text;
    const aiResponse = JSON.parse(rawContent);

    itemProgress.setProgress(90);
    itemProgress.setText("Applying tags...");

    // Filter array client-side to guarantee candidates match availableTags
    const availableTagsSet = new Set(availableTags);
    const suggestedTags = (aiResponse.tags || [])
        .filter(tag => availableTagsSet.has(tag))
        .filter(tag => !currentTags.includes(tag));

    const uniqueSuggestedTags = [...new Set(suggestedTags)];

    let appliedCount = 0;
    for (const tagName of uniqueSuggestedTags) {
        targetItem.addTag(tagName);
        appliedCount++;
    }

    if (appliedCount > 0) {
        await targetItem.saveTx();
    }

    itemProgress.setProgress(100);
    if (appliedCount > 0) {
        for (const tag of uniqueSuggestedTags) {
            progressWindow.addDescription(`• ${tag}`);
        }
        itemProgress.setText(`✅ Added ${appliedCount} tag(s)`);
    } else {
        itemProgress.setText("No new tags found");
    }
    progressWindow.startCloseTimer(5000, true);

} catch (error) {
    if (itemProgress) {
        itemProgress.setError();
        itemProgress.setText(`Error: ${error.message}`);
        progressWindow.startCloseTimer(8000, true);
    } else {
        Zotero.alert(null, "AI Tag Suggester Error", error.message);
    }
}