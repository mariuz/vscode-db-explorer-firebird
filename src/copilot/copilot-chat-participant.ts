import * as vscode from 'vscode';
import { KeywordsDb } from '../language-server/db-words.provider';
import { buildSchemaContext } from './schema-context';
import { logger } from '../logger/logger';

const PARTICIPANT_ID = 'firebird-db-explorer.firebird';

/** System prompt shared across all commands. */
function systemPrompt(schemaBlock: string): string {
    const base =
        'You are a Firebird SQL database expert assistant integrated into VS Code. ' +
        'You help users write, understand, and optimize Firebird SQL queries. ' +
        'Always use Firebird SQL dialect and syntax. ' +
        'When generating SQL, output it inside a fenced ```sql code block.';
    if (schemaBlock) {
        return (
            base +
            '\n\nThe user is connected to a Firebird database with the following schema:\n' +
            schemaBlock
        );
    }
    return base;
}

/**
 * Registers the `@firebird` Copilot Chat participant.
 *
 * Slash commands:
 * - `/query`    – generate Firebird SQL from a natural-language description
 * - `/optimize` – suggest optimisations for a given SQL query
 * - `/explain`  – explain what a SQL query does in plain English
 */
export function registerCopilotChatParticipant(
    context: vscode.ExtensionContext,
    schemaProvider: KeywordsDb
): void {
    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        _chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> => {
        let schema: string = '';
        try {
            const db = await schemaProvider.getSchema();
            schema = buildSchemaContext(db);
        } catch {
            logger.warn('Could not load database schema for Copilot context.');
        }

        const messages: vscode.LanguageModelChatMessage[] = [
            vscode.LanguageModelChatMessage.User(systemPrompt(schema)),
        ];

        switch (request.command) {
            case 'query':
                return handleQuery(request, messages, stream, token);
            case 'optimize':
                return handleOptimize(request, messages, stream, token);
            case 'explain':
                return handleExplain(request, messages, stream, token);
            default:
                return handleDefault(request, messages, stream, token);
        }
    };

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'img', 'icon.png');

    context.subscriptions.push(participant);
    logger.info('Copilot chat participant @firebird registered.');
}

/* ------------------------------------------------------------------ */
/*  /query – natural-language to Firebird SQL                         */
/* ------------------------------------------------------------------ */

async function handleQuery(
    request: vscode.ChatRequest,
    messages: vscode.LanguageModelChatMessage[],
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    if (!request.prompt.trim()) {
        stream.markdown('Please describe the query you need in plain English.\n\nExample: *Show all customers who placed an order in the last 30 days.*');
        return {};
    }

    stream.progress('Generating Firebird SQL…');
    messages.push(
        vscode.LanguageModelChatMessage.User(
            'Generate a Firebird SQL query for the following request. ' +
            'Only output the SQL inside a fenced ```sql code block, followed by a brief explanation.\n\n' +
            request.prompt
        )
    );

    return streamModelResponse(request, messages, stream, token);
}

/* ------------------------------------------------------------------ */
/*  /optimize – AI-assisted query optimisation                        */
/* ------------------------------------------------------------------ */

async function handleOptimize(
    request: vscode.ChatRequest,
    messages: vscode.LanguageModelChatMessage[],
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const sql = request.prompt.trim() || getActiveEditorSql();
    if (!sql) {
        stream.markdown('Please provide a SQL query to optimize, or open one in the editor.');
        return {};
    }

    stream.progress('Analyzing query for optimization…');
    messages.push(
        vscode.LanguageModelChatMessage.User(
            'Analyze the following Firebird SQL query and suggest optimizations. ' +
            'Consider indexing, query structure, and Firebird-specific best practices. ' +
            'Present the optimized query in a fenced ```sql code block and explain the changes.\n\n' +
            '```sql\n' + sql + '\n```'
        )
    );

    return streamModelResponse(request, messages, stream, token);
}

/* ------------------------------------------------------------------ */
/*  /explain – explain SQL in plain English                           */
/* ------------------------------------------------------------------ */

async function handleExplain(
    request: vscode.ChatRequest,
    messages: vscode.LanguageModelChatMessage[],
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const sql = request.prompt.trim() || getActiveEditorSql();
    if (!sql) {
        stream.markdown('Please provide a SQL query to explain, or open one in the editor.');
        return {};
    }

    stream.progress('Explaining query…');
    messages.push(
        vscode.LanguageModelChatMessage.User(
            'Explain the following Firebird SQL query in plain English. ' +
            'Break it down step by step so a beginner can understand it.\n\n' +
            '```sql\n' + sql + '\n```'
        )
    );

    return streamModelResponse(request, messages, stream, token);
}

/* ------------------------------------------------------------------ */
/*  default – general Firebird assistance                             */
/* ------------------------------------------------------------------ */

async function handleDefault(
    request: vscode.ChatRequest,
    messages: vscode.LanguageModelChatMessage[],
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    if (!request.prompt.trim()) {
        stream.markdown(
            'Hi! I\'m the **Firebird SQL** assistant. You can ask me anything about Firebird databases, or use one of the slash commands:\n\n' +
            '- `/query` — Generate SQL from a natural-language description\n' +
            '- `/optimize` — Get optimization suggestions for a SQL query\n' +
            '- `/explain` — Explain what a SQL query does\n'
        );
        return {};
    }

    stream.progress('Thinking…');
    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

    return streamModelResponse(request, messages, stream, token);
}

/* ------------------------------------------------------------------ */
/*  helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Sends a request to the language model selected in Copilot Chat
 * and streams the response tokens to the chat view.
 */
async function streamModelResponse(
    request: vscode.ChatRequest,
    messages: vscode.LanguageModelChatMessage[],
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    try {
        const response = await request.model.sendRequest(messages, {}, token);
        for await (const fragment of response.text) {
            stream.markdown(fragment);
        }
    } catch (err) {
        handleModelError(err, stream);
    }
    return {};
}

function handleModelError(err: unknown, stream: vscode.ChatResponseStream): void {
    if (err instanceof vscode.LanguageModelError) {
        logger.error(`Language model error: ${err.message} [${err.code}]`);
        if (err.cause instanceof Error && err.cause.message.includes('off_topic')) {
            stream.markdown('Sorry, I can only help with Firebird SQL database topics.');
        } else {
            stream.markdown('An error occurred while communicating with the language model. Please try again.');
        }
    } else {
        throw err;
    }
}

/** Returns the text (or selection) from the active SQL editor, if any. */
function getActiveEditorSql(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
        return '';
    }
    const selection = editor.selection;
    return selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);
}
