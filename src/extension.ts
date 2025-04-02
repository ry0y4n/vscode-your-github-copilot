import * as vscode from "vscode";
import fs from "fs";
import path from "path";
import { BlobServiceClient } from "@azure/storage-blob";
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

async function streamToText(readable: NodeJS.ReadableStream): Promise<string> {
    readable.setEncoding("utf8");
    let data = "";
    for await (const chunk of readable) {
        data += chunk;
    }
    return data;
}

export function activate(context: vscode.ExtensionContext) {
    const getCurrentSourceCode = () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const sourceCode = activeEditor.document.getText();
            const fileName = activeEditor.document.fileName;
            const fileUri = vscode.Uri.file(fileName);
            return {
                hasActiveFile: true,
                sourceCode,
                fileUri,
            };
        }
        return {
            hasActiveFile: false,
            sourceCode: "",
            fileUri: vscode.Uri.file(""),
        };
    };

    const handler = async (
        request: vscode.ChatRequest,
        context: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ) => {
        const connectionString = process.env
            .AZURE_STORAGE_CONNECTION_STRING as string;
        const containerName = process.env
            .AZURE_STORAGE_CONTAINER_NAME as string;
        const blobName = process.env.AZURE_STORAGE_BLOB_NAME as string;

        const blobServiceClient =
            BlobServiceClient.fromConnectionString(connectionString);
        const containerClient =
            blobServiceClient.getContainerClient(containerName);
        const blobClient = containerClient.getBlobClient(blobName);

        const offset = 0;
        const length = undefined;
        const downloadBlockBlobResponse = await blobClient.download(
            offset,
            length
        );
        const content = await streamToText(
            downloadBlockBlobResponse.readableStreamBody as NodeJS.ReadableStream
        );

        const basePrompt = `あなたはウェブアプリ開発におけるセキュリティの専門家です。以下の {# チェックリスト} を参考にし、セキュリティ上の問題点を指摘してください。問題点がある場合は、修正案も提示してください。\n\n# チェックリスト\n\n${content}`;

        const messaages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(basePrompt),
        ];

        // 過去のチャット履歴を取得
        let previousMessages = context.history
            .map(
                (
                    messaage: vscode.ChatRequestTurn | vscode.ChatResponseTurn
                ) => {
                    if (messaage instanceof vscode.ChatRequestTurn) {
                        return vscode.LanguageModelChatMessage.User(
                            messaage.prompt
                        );
                    } else if (messaage instanceof vscode.ChatResponseTurn) {
                        let fullMessage = "";
                        messaage.response.forEach((fragment) => {
                            if (typeof fragment.value === "string") {
                                fullMessage += fragment.value;
                            } else if (
                                fragment.value instanceof vscode.MarkdownString
                            ) {
                                fullMessage += fragment.value.value;
                            }
                        });
                    }
                    return null;
                }
            )
            .filter((messaage) => messaage !== null);

        messaages.push(...previousMessages);

        // ここでリファレンスファイルを処理する
        const { hasActiveFile, sourceCode, fileUri } = getCurrentSourceCode();

        let userPrompt = "";
        if (hasActiveFile) {
            userPrompt = `${request.prompt}\n\n# ソース コード\n\`\`\`\n${sourceCode}\`\`\``;
            stream.reference(fileUri);
        } else {
            userPrompt = request.prompt;
        }

        messaages.push(vscode.LanguageModelChatMessage.User(userPrompt));

        const chatResponse = await request.model.sendRequest(
            messaages,
            {},
            token
        );

        for await (const fragment of chatResponse.text) {
            stream.markdown(fragment);
        }

        return;
    };

    const securityChecker = vscode.chat.createChatParticipant(
        "security-checker",
        handler
    );
}

export function deactivate() {}
