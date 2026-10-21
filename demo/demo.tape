# Records demo/demo.gif for the README: `vhs demo/demo.tape` from the repo root, after `npm run build`.
# demo/mock.mjs answers with made-up data for example.com, so no credentials or real property are needed.
Output demo/demo.gif

Set Shell zsh
Set FontSize 13
Set Width 1560
Set Height 280
Set Padding 18
Set Theme "GitHub Dark"
Set TypingSpeed 45ms

Hide
Type `export NODE_OPTIONS="--import $PWD/demo/mock.mjs" PS1='$ ' && alias gscli="node $PWD/dist/cli.js" && clear`
Enter
Show

Type "gscli summary"
Enter
Sleep 3.5s
Hide
Type "clear"
Enter
Show

Type "gscli compare -d page -n 6"
Enter
Sleep 4.5s
Hide
Type "clear"
Enter
Show

Type "gscli opportunities -n 5"
Enter
Sleep 4.5s
Hide
Type "clear"
Enter
Show

Type "gscli inspect https://example.com/pricing https://example.com/blog/keyword-research"
Enter
Sleep 5s
