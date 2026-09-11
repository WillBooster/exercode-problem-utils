/*
MIT License

Copyright (c) Simon Hänisch

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
export const markdownStyles =
  "* {\n\tbox-sizing: border-box;\n}\n\nhtml {\n\tfont-size: 100%;\n}\n\nbody {\n\tfont-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell',\n\t\t'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;\n\tline-height: 1.6;\n\tfont-size: 0.6875em; /* 11 pt */\n\tcolor: #111;\n\tmargin: 0;\n}\n\nbody > :first-child {\n\tpadding-top: 0;\n\tmargin-top: 0;\n}\n\nbody > :last-child {\n\tmargin-bottom: 0;\n\tpadding-bottom: 0;\n}\n\nh1,\nh2,\nh3,\nh4,\nh5,\nh6 {\n\tmargin: 0;\n\tpadding: 0.5em 0 0.25em;\n}\n\nh5,\nh6 {\n\tpadding: 0;\n}\n\nh5 {\n\tfont-size: 1em;\n}\n\nh6 {\n\tfont-size: 0.875em;\n\ttext-transform: uppercase;\n}\n\np {\n\tmargin: 0.25em 0 1em;\n}\n\nblockquote {\n\tmargin: 0.5em 0 1em;\n\tpadding-left: 0.5em;\n\tpadding-right: 1em;\n\tborder-left: 4px solid gainsboro;\n\tfont-style: italic;\n}\n\nul,\nol {\n\tmargin: 0;\n\tmargin-left: 1em;\n\tpadding: 0 1.5em 0.5em;\n}\n\npre {\n\twhite-space: pre-wrap;\n}\n\nh1 code,\nh2 code,\nh3 code,\nh4 code,\nh5 code,\nh6 code,\np code,\nli code,\npre code {\n\tbackground-color: #f8f8f8;\n\tpadding: 0.1em 0.375em;\n\tborder: 1px solid #f8f8f8;\n\tborder-radius: 0.25em;\n\tfont-family: monospace;\n\tfont-size: 1.2em;\n}\n\npre code {\n\tdisplay: block;\n\tpadding: 0.5em;\n}\n\n.page-break {\n\tpage-break-after: always;\n}\n\nimg {\n\tmax-width: 100%;\n\tmargin: 1em 0;\n}\n\ntable {\n\tborder-spacing: 0;\n\tborder-collapse: collapse;\n\tdisplay: block;\n\tmargin: 0 0 1em;\n\twidth: 100%;\n\toverflow: auto;\n}\n\ntable th,\ntable td {\n\tpadding: 0.5em 1em;\n\tborder: 1px solid gainsboro;\n}\n\ntable th {\n\tfont-weight: 600;\n}\n\ntable tr {\n\tbackground-color: white;\n\tborder-top: 1px solid gainsboro;\n}\n\ntable tr:nth-child(2n) {\n\tbackground-color: whitesmoke;\n}\n";

/*
BSD 3-Clause License

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
export const highlightStyles =
  "pre code.hljs {\n  display: block;\n  overflow-x: auto;\n  padding: 1em\n}\ncode.hljs {\n  padding: 3px 5px\n}\n/*!\n  Theme: GitHub\n  Description: Light theme as seen on github.com\n  Author: github.com\n  Maintainer: @Hirse\n  Updated: 2021-05-15\n\n  Outdated base version: https://github.com/primer/github-syntax-light\n  Current colors taken from GitHub's CSS\n*/\n.hljs {\n  color: #24292e;\n  background: #ffffff\n}\n.hljs-doctag,\n.hljs-keyword,\n.hljs-meta .hljs-keyword,\n.hljs-template-tag,\n.hljs-template-variable,\n.hljs-type,\n.hljs-variable.language_ {\n  /* prettylights-syntax-keyword */\n  color: #d73a49\n}\n.hljs-title,\n.hljs-title.class_,\n.hljs-title.class_.inherited__,\n.hljs-title.function_ {\n  /* prettylights-syntax-entity */\n  color: #6f42c1\n}\n.hljs-attr,\n.hljs-attribute,\n.hljs-literal,\n.hljs-meta,\n.hljs-number,\n.hljs-operator,\n.hljs-variable,\n.hljs-selector-attr,\n.hljs-selector-class,\n.hljs-selector-id {\n  /* prettylights-syntax-constant */\n  color: #005cc5\n}\n.hljs-regexp,\n.hljs-string,\n.hljs-meta .hljs-string {\n  /* prettylights-syntax-string */\n  color: #032f62\n}\n.hljs-built_in,\n.hljs-symbol {\n  /* prettylights-syntax-variable */\n  color: #e36209\n}\n.hljs-comment,\n.hljs-code,\n.hljs-formula {\n  /* prettylights-syntax-comment */\n  color: #6a737d\n}\n.hljs-name,\n.hljs-quote,\n.hljs-selector-tag,\n.hljs-selector-pseudo {\n  /* prettylights-syntax-entity-tag */\n  color: #22863a\n}\n.hljs-subst {\n  /* prettylights-syntax-storage-modifier-import */\n  color: #24292e\n}\n.hljs-section {\n  /* prettylights-syntax-markup-heading */\n  color: #005cc5;\n  font-weight: bold\n}\n.hljs-bullet {\n  /* prettylights-syntax-markup-list */\n  color: #735c0f\n}\n.hljs-emphasis {\n  /* prettylights-syntax-markup-italic */\n  color: #24292e;\n  font-style: italic\n}\n.hljs-strong {\n  /* prettylights-syntax-markup-bold */\n  color: #24292e;\n  font-weight: bold\n}\n.hljs-addition {\n  /* prettylights-syntax-markup-inserted */\n  color: #22863a;\n  background-color: #f0fff4\n}\n.hljs-deletion {\n  /* prettylights-syntax-markup-deleted */\n  color: #b31d28;\n  background-color: #ffeef0\n}\n.hljs-char.escape_,\n.hljs-link,\n.hljs-params,\n.hljs-property,\n.hljs-punctuation,\n.hljs-tag {\n  /* purposely ignored */\n  \n}";
