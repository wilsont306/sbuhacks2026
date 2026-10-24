-- Living Blueprint v2: the Snowflake side of saved projects (lib/snowflake.js, api/projects.js).
-- G runs this once in a Snowsight worksheet on the trial account (AWS us-east-1, to sit next to Vercel iad1).
-- The app talks to Snowflake only through the SQL REST API with a key-pair JWT: no password, no driver.
-- Every object is named in full (LB_DB.APP.PROJECTS, LB_DB.APP, LB_WH, LB_APP), so each statement works whatever
-- database, schema or warehouse the worksheet happens to be set to.
--
-- 1. Key pair, on a laptop (never commit rsa_key.p8; .gitignore it or keep it outside the repo):
--      openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
--      openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
--    rsa_key.p8 is an unencrypted PKCS#8 PEM ("BEGIN PRIVATE KEY"): paste the whole file into Vercel as
--    SNOWFLAKE_PRIVATE_KEY. rsa_key.pub's base64 lines (without the BEGIN/END lines, joined) go into RSA_PUBLIC_KEY below.
--    The fingerprint the JWT carries, to compare with DESCRIBE USER in step 3:
--      openssl rsa -pubin -in rsa_key.pub -outform DER | openssl dgst -sha256 -binary | openssl enc -base64
--
-- 2. Setup, as ACCOUNTADMIN. Uncomment, paste the public key, run once:
-- USE ROLE ACCOUNTADMIN;
-- CREATE WAREHOUSE IF NOT EXISTS LB_WH WAREHOUSE_SIZE = 'XSMALL' AUTO_SUSPEND = 600 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE;
-- CREATE DATABASE IF NOT EXISTS LB_DB;
-- CREATE SCHEMA IF NOT EXISTS LB_DB.APP;
-- CREATE ROLE IF NOT EXISTS LB_APP;
-- GRANT USAGE ON WAREHOUSE LB_WH TO ROLE LB_APP;
-- GRANT USAGE ON DATABASE LB_DB TO ROLE LB_APP;
-- GRANT USAGE ON SCHEMA LB_DB.APP TO ROLE LB_APP;
-- GRANT SELECT, INSERT ON FUTURE TABLES IN SCHEMA LB_DB.APP TO ROLE LB_APP;
-- GRANT ROLE LB_APP TO ROLE SYSADMIN;
-- CREATE USER IF NOT EXISTS LB_SERVICE
--   TYPE = SERVICE
--   DEFAULT_ROLE = LB_APP
--   DEFAULT_WAREHOUSE = LB_WH
--   DEFAULT_NAMESPACE = LB_DB.APP
--   RSA_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...paste...';
-- GRANT ROLE LB_APP TO USER LB_SERVICE;
--
-- 3. Check the key landed: RSA_PUBLIC_KEY_FP must read SHA256: followed by the openssl fingerprint from step 1.
-- DESCRIBE USER LB_SERVICE;
--
-- 4. Vercel env (Production and Preview), then redeploy:
--      SNOWFLAKE_ACCOUNT   = the result of the query below (orgname-accountname), e.g. abcdefg-xy12345
--      SNOWFLAKE_USER      = LB_SERVICE
--      SNOWFLAKE_PRIVATE_KEY = contents of rsa_key.p8
--      SNOWFLAKE_WAREHOUSE = LB_WH    SNOWFLAKE_DATABASE = LB_DB    SNOWFLAKE_SCHEMA = APP    SNOWFLAKE_ROLE = LB_APP
-- SELECT CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME();
--
-- 5. The table. ID is a crypto.randomUUID from the app; Snowflake does not enforce PRIMARY KEY, so it is a label,
--    not a guard. SCENE holds the scene JSON that /api/interpret returns. (The app itself writes plain PROJECTS:
--    the request body names SNOWFLAKE_DATABASE and SNOWFLAKE_SCHEMA, which resolve it to this table.)
CREATE TABLE IF NOT EXISTS LB_DB.APP.PROJECTS (
  ID STRING PRIMARY KEY,
  NAME STRING,
  CREATED_AT TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  SOURCE STRING,
  IMAGE_URL STRING,
  SCENE_URL STRING,
  SCENE VARIANT,
  TITLE_GUESS STRING,
  ARTIST_GUESS STRING,
  CREDIT STRING
);
-- The future grant in step 2 covers a table made after it; if the table already existed, grant it directly:
-- GRANT SELECT, INSERT ON TABLE LB_DB.APP.PROJECTS TO ROLE LB_APP;
-- SHOW GRANTS ON TABLE LB_DB.APP.PROJECTS;
--
-- 6. What the app runs, for a by-hand check (Query History in Snowsight shows the app's own calls as LB_SERVICE).
--    Saves are sent asynchronously: the Vercel log line "snowflake save: <id> accepted, statementHandle <handle>"
--    gives the handle, which is the Query ID to filter Query History by when a save did not land.
-- INSERT INTO LB_DB.APP.PROJECTS (ID, NAME, SOURCE, IMAGE_URL, SCENE_URL, SCENE, TITLE_GUESS, ARTIST_GUESS, CREDIT)
--   SELECT 'test-1', 'Test', 'sample', '', '', PARSE_JSON('{"objects":[]}'), '', '', NULL;
-- SELECT ID, NAME, SOURCE, CREATED_AT FROM LB_DB.APP.PROJECTS ORDER BY CREATED_AT DESC LIMIT 24;
-- DELETE FROM LB_DB.APP.PROJECTS WHERE ID = 'test-1';
