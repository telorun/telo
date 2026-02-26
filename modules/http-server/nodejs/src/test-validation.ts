// Test file to validate error conversion logic
import { convertFastifyValidationError } from "./http-api-controller.js";

function testValidationError() {
  // Test case 1: Querystring validation error
  const error1 = {
    code: "FST_ERR_VALIDATION",
    message: "querystring must have required property 'name'",
    statusCode: 400,
    error: "Bad Request",
  };

  const result1 = convertFastifyValidationError(error1);
  console.log("Test 1 - Querystring required field:", JSON.stringify(result1, null, 2));

  console.log("✓ Location:", result1?.details[0].location === "query" ? "PASS" : "FAIL");
  console.log("✓ Path:", result1?.details[0].path === "name" ? "PASS" : "FAIL");
  console.log("✓ Message:", result1?.details[0].message.includes("required") ? "PASS" : "FAIL");

  // Test case 2: Body validation error
  const error2 = {
    code: "FST_ERR_VALIDATION",
    message: "body must be object",
    statusCode: 400,
  };

  const result2 = convertFastifyValidationError(error2);
  console.log("\nTest 2 - Body type error:", JSON.stringify(result2, null, 2));
  console.log("✓ Location:", result2?.details[0].location === "body" ? "PASS" : "FAIL");

  // Test case 3: Non-validation error (should return null)
  const error3 = {
    code: "ERR_OTHER",
    message: "Some other error",
  };

  const result3 = convertFastifyValidationError(error3);
  console.log(
    "\nTest 3 - Non-validation error:",
    result3 === null ? "PASS (null)" : "FAIL (not null)",
  );
}

// Only run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testValidationError();
}
