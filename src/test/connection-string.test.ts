import * as assert from 'assert';
import { parseConnectionString, buildConnectionString } from '../shared/connection-string';
import { ConnectionOptions } from '../interfaces';

function conn(overrides: Partial<ConnectionOptions>): ConnectionOptions {
  return {
    id: 'test-id',
    host: 'localhost',
    port: 3050,
    database: 'employee',
    user: 'sysdba',
    password: 'masterkey',
    role: null,
    embedded: false,
    ...overrides,
  };
}

suite('connection-string – parseConnectionString()', function () {
  test('parses host/port/database/user/password', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/employee');
    assert.deepStrictEqual(parsed, {
      host: 'localhost',
      database: 'employee',
      embedded: false,
      port: 3050,
      user: 'sysdba',
      password: 'masterkey',
    });
  });

  test('parses an absolute database path given with the doubled-slash convention', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050//var/lib/firebird/data/test.fdb');
    assert.strictEqual(parsed?.database, '/var/lib/firebird/data/test.fdb');
  });

  test('restores a missing leading slash when a single-slash path still looks absolute', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/var/lib/firebird/data/test.fdb');
    assert.strictEqual(parsed?.database, '/var/lib/firebird/data/test.fdb');
  });

  test('treats a single path segment with no further slashes as a bare alias', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/employee');
    assert.strictEqual(parsed?.database, 'employee');
  });

  test('defaults port/user/password to undefined when omitted, for the caller to fill in', function () {
    const parsed = parseConnectionString('firebird://localhost/employee');
    assert.strictEqual(parsed?.port, undefined);
    assert.strictEqual(parsed?.user, undefined);
    assert.strictEqual(parsed?.password, undefined);
    assert.strictEqual(parsed?.host, 'localhost');
  });

  test('parses a role query parameter', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/employee?role=READER');
    assert.strictEqual(parsed?.role, 'READER');
  });

  test('parses a valid wireCrypt query parameter', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/employee?wireCrypt=Disabled');
    assert.strictEqual(parsed?.wireCrypt, 'Disabled');
  });

  test('ignores an invalid wireCrypt value rather than passing it through', function () {
    const parsed = parseConnectionString('firebird://sysdba:masterkey@localhost:3050/employee?wireCrypt=Nonsense');
    assert.strictEqual(parsed?.wireCrypt, undefined);
  });

  test('URL-decodes a password containing special characters', function () {
    const parsed = parseConnectionString('firebird://sysdba:p%40ss%3Aword@localhost:3050/employee');
    assert.strictEqual(parsed?.password, 'p@ss:word');
  });

  test('returns undefined for an empty or whitespace-only string', function () {
    assert.strictEqual(parseConnectionString(''), undefined);
    assert.strictEqual(parseConnectionString('   '), undefined);
  });

  test('returns undefined for a non-URL string', function () {
    assert.strictEqual(parseConnectionString('not a connection string'), undefined);
  });

  test('returns undefined for a URL with the wrong scheme', function () {
    assert.strictEqual(parseConnectionString('postgres://user:pass@localhost:5432/db'), undefined);
  });

  test('returns undefined when there is no database path at all', function () {
    assert.strictEqual(parseConnectionString('firebird://sysdba:masterkey@localhost:3050'), undefined);
  });
});

suite('connection-string – buildConnectionString() (docs/roadmap/connection-management-enhancements.md, phase 2)', function () {
  test('builds a Firebird-native host/port:database DSN for a network connection', function () {
    const text = buildConnectionString(conn({}));
    assert.ok(text.startsWith('localhost/3050:employee'), text);
  });

  test('omits the port segment when unset', function () {
    const text = buildConnectionString(conn({ port: null }));
    assert.ok(text.startsWith('localhost:employee'), text);
  });

  test('an embedded connection is just the bare database path -- no host/port at all', function () {
    const text = buildConnectionString(conn({ embedded: true, host: '', port: null, database: '/var/lib/firebird/data/test.fdb' }));
    assert.ok(text.startsWith('/var/lib/firebird/data/test.fdb'), text);
  });

  test('the password never appears anywhere in the output', function () {
    const text = buildConnectionString(conn({ password: 'super-secret-value' }));
    assert.ok(!text.includes('super-secret-value'), text);
    assert.ok(!text.toLowerCase().includes('super-secret'));
  });

  test('a real, non-empty user is called out on its own line', function () {
    const text = buildConnectionString(conn({ user: 'sysdba' }));
    assert.ok(text.includes('-- User: sysdba'), text);
  });

  test('an unset user is not mentioned at all, rather than printing a blank "User:" line', function () {
    const text = buildConnectionString(conn({ user: '' }));
    assert.ok(!text.includes('-- User:'), text);
  });

  test('always notes that the password was deliberately left out', function () {
    const text = buildConnectionString(conn({}));
    assert.ok(text.includes('Password not included'), text);
  });

  test('builds a Firebird URL format (firebird://)', function () {
    const text = buildConnectionString(conn({ user: 'sysdba', host: 'db.example.com', port: 3050, database: 'sales' }), 'url');
    assert.strictEqual(text, 'firebird://sysdba@db.example.com:3050/sales');
  });

  test('builds a JDBC URL format (jdbc:firebirdsql://)', function () {
    const text = buildConnectionString(conn({ user: 'sysdba', host: 'localhost', port: 3050, database: 'test.fdb' }), 'jdbc');
    assert.strictEqual(text, 'jdbc:firebirdsql://localhost:3050/test.fdb?user=sysdba');
  });

  test('builds a node-firebird JS config format', function () {
    const text = buildConnectionString(conn({ user: 'SYSDBA', host: 'localhost', port: 3050, database: 'employee' }), 'node');
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.host, 'localhost');
    assert.strictEqual(parsed.port, 3050);
    assert.strictEqual(parsed.database, 'employee');
    assert.strictEqual(parsed.user, 'SYSDBA');
  });
});
