import dotenv from "dotenv";

// Loaded before any test file or application module. Ensures the app
// connects to the isolated test database/redis db, never dev or prod.
dotenv.config({ path: ".env.test", override: true });
