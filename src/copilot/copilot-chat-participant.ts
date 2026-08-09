import * as vscode from 'vscode';
import { KeywordsDb } from '../language-server/db-words.provider';
import { buildSchemaContext } from './schema-context';
import { systemPrompt, buildOptimizeMessages, buildExplainMessages, buildMigrateMessages, buildConnectMessages, buildSchemaPromptMessages, buildMockMessages } from './prompts';
import { logger } from '../logger/logger';

const PARTICIPANT_ID = 'firebird-db-explorer.firebird';

/**
 * Registers the `@firebird` Copilot Chat participant.
 *
 * Slash commands:
 * - `/query`        – generate Firebird SQL from a natural-language description
 * - `/optimize`     – suggest optimisations for a given SQL query
 * - `/explain`      – explain what a SQL query does in plain English
 * - `/designSchema` – infer a Firebird table schema (DDL) from sample data
 * - `/migrate`      – convert DDL from another database system to Firebird SQL
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

        switch (request.command) {
            case 'connect':
                return handleConnect(request, schema, stream, token);
            case 'schema':
                return handleSchema(request, schema, stream, token);
            case 'mock':
                return handleMock(request, schema, stream, token);
            case 'query': {
                const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(systemPrompt(schema))];
                return handleQuery(request, messages, stream, token);
            }
            case 'optimize':
                return handleOptimize(request, schema, stream, token);
            case 'explain':
                return handleExplain(request, schema, stream, token);
            case 'designSchema': {
                const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(systemPrompt(schema))];
                return handleDesignSchema(request, messages, stream, token);
            }
            case 'migrate':
                return handleMigrate(request, schema, stream, token);
            default: {
                const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(systemPrompt(schema))];
                return handleDefault(request, messages, stream, token);
            }
        }
    };

    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'img', 'icon.png');

    context.subscriptions.push(participant);
    logger.info('Copilot chat participant @firebird registered.');
}

/* ------------------------------------------------------------------ */
/*  /connect – switch or connect to a saved database                  */
/* ------------------------------------------------------------------ */
async function handleConnect(
    request: vscode.ChatRequest,
    schema: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    stream.progress('Analyzing connection request…');
    const messages = buildConnectMessages(request.prompt.trim(), schema);
    return streamModelResponse(request, messages, stream, token);
}

/* ------------------------------------------------------------------ */
/*  /schema <table> – generate ER snippet or table DDL                */
/* ------------------------------------------------------------------ */
async function handleSchema(
    request: vscode.ChatRequest,
    schema: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    stream.progress('Generating DDL and schema definition…');
    const messages = buildSchemaPromptMessages(request.prompt.trim(), schema);
    return streamModelResponse(request, messages, stream, token);
}

/* ------------------------------------------------------------------ */
/*  /mock <table> – generate mock data INSERT scripts                */
/* ------------------------------------------------------------------ */
async function handleMock(
    request: vscode.ChatRequest,
    schema: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    stream.progress('Generating mock data INSERT script…');
    const messages = buildMockMessages(request.prompt.trim(), schema);
    return streamModelResponse(request, messages, stream, token);
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
    schema: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const sql = request.prompt.trim() || getActiveEditorSql();
    if (!sql) {
        stream.markdown('Please provide a SQL query to optimize, or open one in the editor.');
        return {};
    }

    stream.progress('Analyzing query for optimization…');
    return streamModelResponse(request, buildOptimizeMessages(sql, schema), stream, token);
}

/* ------------------------------------------------------------------ */
/*  /explain – explain SQL in plain English                           */
/* ------------------------------------------------------------------ */

async function handleExplain(
    request: vscode.ChatRequest,
    schema: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const sql = request.prompt.trim() || getActiveEditorSql();
    if (!sql) {
        stream.markdown('Please provide a SQL query to explain, or open one in the editor.');
        return {};
    }

    stream.progress('Explaining query…');
    return streamModelResponse(request, buildExplainMessages(sql, schema), stream, token);
}

/* ------------------------------------------------------------------ */
/*  /designSchema – AI-assisted schema design from sample data         */
/* ------------------------------------------------------------------ */

async function handleDesignSchema(
    request: vscode.ChatRequest,
    messages: vscode.LanguageModelChatMessage[],
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const sampleData = request.prompt.trim() || getActiveEditorText();
    if (!sampleData) {
        stream.markdown(
            'Please paste some sample data (CSV, JSON rows, or a plain description of the fields), ' +
            'or open a file containing it, and I\'ll suggest a Firebird table schema.\n\n' +
            'Example:\n```\nid,name,email,signup_date\n1,Jane Doe,jane@example.com,2024-03-01\n```'
        );
        return {};
    }

    stream.progress('Designing schema from sample data…');
    messages.push(
        vscode.LanguageModelChatMessage.User(
            'The user will provide sample data (CSV, JSON, or plain-text rows). Infer an appropriate ' +
            'Firebird table schema from it: a reasonable table name, column names, Firebird data types ' +
            '(e.g. VARCHAR(n), INTEGER, BIGINT, NUMERIC(p,s), DATE, TIMESTAMP, BOOLEAN, BLOB SUB_TYPE TEXT), ' +
            'a primary key, and NOT NULL constraints where the data suggests they apply. ' +
            'Output one or more ```sql``` fenced CREATE TABLE statements, followed by a brief explanation ' +
            'of the inferred types and any assumptions you made.\n\nSample data:\n' + sampleData
        )
    );

    return streamModelResponse(request, messages, stream, token);
}

/* ------------------------------------------------------------------ */
/*  /migrate – AI-assisted DDL conversion from other database systems  */
/* ------------------------------------------------------------------ */

async function handleMigrate(
    request: vscode.ChatRequest,
    schema: string,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const sourceDdl = request.prompt.trim() || getActiveEditorText();
    if (!sourceDdl) {
        stream.markdown(
            'Please paste the DDL you want to convert (from MySQL, PostgreSQL, SQL Server, Oracle, ' +
            'or legacy InterBase), or open a file containing it, and I\'ll convert it to Firebird SQL.\n\n' +
            'Example:\n```sql\nCREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name TEXT);\n```'
        );
        return {};
    }

    stream.progress('Converting DDL to Firebird SQL…');
    return streamModelResponse(request, buildMigrateMessages(sourceDdl, schema), stream, token);
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
            '- `/connect` — Switch or connect to a saved database\n' +
            '- `/schema <table>` — Generate ER snippet or table DDL\n' +
            '- `/explain` — Explain what a SQL query or execution plan does\n' +
            '- `/optimize` — Suggest PSQL and index optimizations\n' +
            '- `/mock <table>` — Generate mock data INSERT scripts\n' +
            '- `/query` — Generate SQL from a natural-language description\n' +
            '- `/designSchema` — Infer a Firebird table schema from sample data\n' +
            '- `/migrate` — Convert DDL from another database system to Firebird SQL\n'
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
        // Error.cause isn't declared under our ES2019 lib target; the vscode.d.ts docs
        // guarantee LanguageModelError populates it for code "Unknown".
        const cause = (err as { cause?: unknown }).cause;
        if (cause instanceof Error && cause.message.includes('off_topic')) {
            stream.markdown('Sorry, I can only help with Firebird SQL database topics.');
        } else {
            stream.markdown('An error occurred while communicating with the language model. Please try again.');
        }
    } else {
        throw err;
    }
}

/** Returns the text (or selection) from the active SQL editor, if any. */
export function getActiveEditorSql(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
        return '';
    }
    const selection = editor.selection;
    return selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);
}

/** Returns the text (or selection) from the active editor, regardless of language. */
function getActiveEditorText(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return '';
    }
    const selection = editor.selection;
    return selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);
}
