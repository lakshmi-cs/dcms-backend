const mysql = require("mysql");

const pool = mysql.createPool({
  connectionLimit: 10,
  host: process.env.TIDB_HOST,
  port: process.env.TIDB_PORT,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE,
  dateStrings: true,
  ssl: {
    rejectUnauthorized: false,
  },
});

function query(sql, params = [], connection = pool) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (error, results) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(results);
    });
  });
}

function getConnection() {
  return new Promise((resolve, reject) => {
    pool.getConnection((error, connection) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(connection);
    });
  });
}

async function withTransaction(work) {
  const connection = await getConnection();

  try {
    await new Promise((resolve, reject) => {
      connection.beginTransaction((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    const result = await work(connection);

    await new Promise((resolve, reject) => {
      connection.commit((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    return result;
  } catch (error) {
    await new Promise((resolve) => {
      connection.rollback(() => resolve());
    });
    throw error;
  } finally {
    connection.release();
  }
}

async function ping() {
  await query("SELECT 1");
}

module.exports = {
  pool,
  query,
  ping,
  withTransaction,
};
