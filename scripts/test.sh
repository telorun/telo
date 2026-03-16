#!/bin/bash

# Test runner script that discovers and runs all YAML test files in tests/ directory

TESTS_DIR="tests"
PASSED=0
FAILED=0
FAILED_TESTS=()

# Check if tests directory exists
if [ ! -d "$TESTS_DIR" ]; then
    echo "❌ Tests directory '$TESTS_DIR' not found"
    exit 1
fi

# Find all .yaml files in tests directory, optionally filtered by partial path
FILTER="${1:-}"
echo "🔍 Discovering tests in $TESTS_DIR/..."
TEST_FILES=()
while IFS= read -r -d '' file; do
    if [ -z "$FILTER" ] || [[ "$file" == *"$FILTER"* ]]; then
        TEST_FILES+=("$file")
    fi
done < <(find . -path "*/$TESTS_DIR/*.yaml" -print0 | sort -z)

if [ ${#TEST_FILES[@]} -eq 0 ]; then
    echo "⚠️  No test files found in $TESTS_DIR/"
    exit 1
fi

TEST_COUNT=${#TEST_FILES[@]}
echo "📋 Found $TEST_COUNT test(s)"
echo ""

# Run each test
for test_file in "${TEST_FILES[@]}"; do
    test_name=$(basename "$test_file")
    echo "▶️  Running: $test_name"
    
    # Run test directly (no capture) so ANSI colors are preserved
    if pnpm run telo "$test_file" 2>&1; then
        echo "✅ PASSED: $test_name"
        ((PASSED++))
    else
        echo "❌ FAILED: $test_name"
        ((FAILED++))
        FAILED_TESTS+=("$test_name")
    fi
    echo ""
done

# Print summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Test Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Passed: $PASSED"
echo "❌ Failed: $FAILED"
echo "📈 Total:  $((PASSED + FAILED))"
echo ""

# Print failed tests if any
if [ $FAILED -gt 0 ]; then
    echo "Failed tests:"
    for test in "${FAILED_TESTS[@]}"; do
        echo "  - $test"
    done
    echo ""
    exit 1
fi

echo "✨ All tests passed!"
exit 0
