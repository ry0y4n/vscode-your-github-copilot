import * as vscode from "vscode";
import fs from "fs";
import path from "path";
import { BlobServiceClient } from "@azure/storage-blob";
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const BASE_PROMPT = `
## 1. インジェクション（Injection）
### チェックポイント:

- ユーザー入力を信頼しない。
- パラメータ化クエリ（Prepared Statement）を使用する。
- 入力値を適切に検証・サニタイズする。

## 2. 認証の不備（Broken Authentication）
### チェックポイント:

- セッションIDを安全に生成・管理する。
- パスワード保存には安全なハッシュアルゴリズム（例: bcrypt）を使用する。
- 多要素認証（MFA）を導入する。

## 3. 機密情報の露出（Sensitive Data Exposure）
### チェックポイント:

- 機密情報は暗号化する（例: TLS、AES）。
- 安全な通信プロトコル（HTTPS）を強制する。
- 機密データをログに記録しない。

## 4. XML外部エンティティ（XXE）
### チェックポイント:

- 外部エンティティを無効化する。
- XMLパーサーの設定をセキュアにする。
- XMLの代わりにJSONを使用することを検討する。

## 5. アクセス制御の不備（Broken Access Control）
### チェックポイント:

- ロールベースまたは属性ベースのアクセス制御を実装する。
- デフォルトでアクセスを拒否するポリシーを設定する。
- サーバーサイドでアクセス権を検証する。

## 6. セキュリティ設定ミス（Security Misconfiguration）
### チェックポイント:

- 不要な機能やサービスを無効化する。
- アップデートとパッチ適用を定期的に行う。
- 詳細なエラーメッセージをユーザーに表示しない。

## 7. クロスサイトスクリプティング（XSS）
### チェックポイント:

- HTMLエンティティのエスケープ処理を行う。
- JavaScriptのコンテンツセキュリティポリシー（CSP）を設定する。
- ユーザー入力を適切にサニタイズする。

## 8. 不十分な安全性のあるデシリアライズ（Insecure Deserialization）
### チェックポイント:

- 信頼できないデータをデシリアライズしない。
- デシリアライズ時のデータの検証を行う。
- JSON Web Token（JWT）など安全な形式を使用する。

## 9. 使用済みコンポーネントの脆弱性（Using Components with Known Vulnerabilities）
### チェックポイント:

- 使用しているライブラリやフレームワークの脆弱性を定期的に確認する。
- 必要に応じて最新版にアップデートする。
- 不要な依存関係を削除する。

## 10. 不十分なログとモニタリング（Insufficient Logging & Monitoring）
### チェックポイント:

- セキュリティ関連のイベントを適切に記録する。
- 不正アクセスや異常をリアルタイムで検知する仕組みを導入する。
- ログデータを安全に保管する。
`;

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
