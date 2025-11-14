import { assert, expect, test } from 'vitest';

import { removeCommentsInSourceCode } from '../../src/helpers/removeCommentsInSourceCode.js';
import { languageIdToDefinition } from '../../src/types/language.js';

test.each<[string, string, string]>([
  [
    'java',
    `/**
 * A multi-line comment
 * @author ABC
 */
public class Main {
  /* An inline comment */
  public static void main(String[] args) {
    // A single-line comment
    System.out.println("// Not a comment");
    String str = "/* Also not a comment */";
  }
}
`,
    `
public class Main {
  public static void main(String[] args) {
    System.out.println("// Not a comment");
    String str = "/* Also not a comment */";
  }
}
`,
  ],
  [
    'python',
    `#!/usr/bin/env python3
# -*- coding: utf-8 -*-

'''
A multi-line docstring
'''
def main():
    # A single-line comment
    print("# Not a comment")
    """Another docstring"""
    str = '# Also not a comment'

    def nested_function():
        # Nested comment
        pass

if __name__ == "__main__":
    main()
`,
    `

def main():
    print("# Not a comment")
    str = '# Also not a comment'

    def nested_function():
        pass

if __name__ == "__main__":
    main()
`,
  ],
  [
    'haskell',
    `{-
Multi-line comment
in Haskell
-}
module Main where

-- Single line comment
main :: IO ()
main = do
    putStrLn "Hello, {- not a comment -} World!" -- End of line comment
    let x = 5 {- Inline comment -}
`,
    `
module Main where

main :: IO ()
main = do
    putStrLn "Hello, {- not a comment -} World!"
    let x = 5
`,
  ],
  [
    'php',
    `<?php
/**
 * PHP multi-line comment
 */
function hello() {
    // Single line comment
    echo "Hello, // not a comment";
    /* Another comment */
    $str = '# Not a comment';
    # Alternative single line comment
}
?>
`,
    `<?php
function hello() {
    echo "Hello, // not a comment";
    $str = '# Not a comment';
}
?>
`,
  ],
  [
    'ruby',
    `#!/usr/bin/env ruby

=begin
Multi-line comment
in Ruby
=end

# Single line comment
def hello
  puts "Hello, # not a comment"
  str = '# Also not a comment'
end

hello  # End of line comment
`,
    `


def hello
  puts "Hello, # not a comment"
  str = '# Also not a comment'
end

hello
`,
  ],
  [
    'html',
    `<!DOCTYPE html>
<html>
  <head>
    <title>HTML Test</title>
    <!-- This is an HTML comment -->
  </head>
  <body>
    <!-- Multi-line
         comment -->
    <p>This is <!-- inline comment --> a test.</p>
    <div>"<!-- Not a comment -->"</div>
  </body>
</html>
`,
    `<!DOCTYPE html>
<html>
  <head>
    <title>HTML Test</title>
  </head>
  <body>
    <p>This is a test.</p>
    <div>"<!-- Not a comment -->"</div>
  </body>
</html>
`,
  ],
  [
    'css',
    `/* Basic CSS comment */
body {
  margin: 0;
  /* Multi-line
     CSS comment */
  padding: 0;
}

header {
  color: white; /* Inline comment */
}
`,
    `
body {
  margin: 0;
  padding: 0;
}

header {
  color: white;
}
`,
  ],
  [
    'jsp',
    `<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<!DOCTYPE html>
<html>
<head>
  <title>JSP Test</title>
  <!-- HTML Comment -->
  <%-- JSP Comment --%>
</head>
<body>
  <%
    /* Java block comment */
    String message = "Hello World";
    // Java line comment
    out.println(message); // End of line comment
  %>
  <!-- Multi-line
       HTML comment -->
  <p>This is <%-- inline JSP comment --%> a test.</p>
  <div>"<!-- Not a comment -->"</div>
  <script>
    // JavaScript comment in JSP
    let x = "<%-- This is not a JSP comment because it's in a string --%>";
  </script>
</body>
</html>
`,
    `<%@ page language="java" contentType="text/html; charset=UTF-8" pageEncoding="UTF-8"%>
<!DOCTYPE html>
<html>
<head>
  <title>JSP Test</title>
</head>
<body>
  <%
    String message = "Hello World";
    out.println(message);
  %>
  <p>This is a test.</p>
  <div>"<!-- Not a comment -->"</div>
  <script>
    let x = "<%-- This is not a JSP comment because it's in a string --%>";
  </script>
</body>
</html>
`,
  ],
])('%s', (language, sourceCode, expected) => {
  const languageDefinition = languageIdToDefinition[language];
  assert(languageDefinition?.grammer);
  expect(removeCommentsInSourceCode(languageDefinition.grammer, sourceCode)).toEqual(expected);
});
