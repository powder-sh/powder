// Dockerfile case tables of the continuation, heredoc and FROM / --from ref tests, in one
// module so dockerfile-twin-parity.test.ts runs them through both twins. Invented names only.

// Dockerfiles BuildKit reads in a way an unchecked instruction, flag or source
// would slip through: each must be refused.
export const CONT_MUST_REFUSE: Array<[string, string]> = [
	['ADD flag glued to the continuation, git source on the next line', 'FROM alpine\nADD --chown=0\\\n git@github.com:org/priv.git /x\n'],
	['ADD flag glued, URL on a tab-indented line', 'FROM alpine\nADD --chown=0\\\n\thttps://x.example/a.tgz /y\n'],
	['ADD source glued, git remote on an indented line', 'FROM alpine\nADD a\\\n\tgithub.com/org/repo /y\n'],
	['ADD source glued, a comment line in between', 'FROM alpine\nADD a\\\n# note\n\tgithub.com/org/repo /y\n'],
	['ADD source glued, blank lines in between', 'FROM alpine\nADD a\\\n\n   \n\tgithub.com/org/repo /y\n'],
	['lines ending in a double backslash (not a continuation)', 'FROM alpine\nRUN echo x\\\\\nRUN --network=host --security=insecure wget -qO- http://169.254.169.254/\nRUN echo y\\\\\nFROM evil/onbuild:latest\nRUN id\n'],
	['a triple backslash', 'FROM alpine\nRUN echo a\\\\\\\nFROM evil:1\n'],
	['a double backslash with trailing blanks', 'FROM alpine\nRUN echo x\\\\  \t\nFROM evil:1\n'],
	['RUN mount glued, --network=host on the next line', 'FROM alpine\nRUN --mount=type=cache,target=/a\\\n  --network=host id\n'],
	['ADD flag glued, trailing spaces after the backslash', 'FROM alpine\nADD --chown=0\\   \n https://x.example/a /y\n'],
	['CRLF: ADD flag glued, git source on the next line', 'FROM alpine\r\nADD --chown=0\\\r\n git@github.com:org/priv.git /x\r\n'],
	['CRLF: a double backslash', 'FROM alpine\r\nRUN echo x\\\\\r\nFROM evil:1\r\n'],
	['ONBUILD continued, RUN mount glued, id= on the next line', 'FROM alpine\nONBUILD \\\nRUN --mount=type=cache,target=/a\\\n,id=other id\n'],
	['ONBUILD continued, RUN flag glued', 'FROM alpine\nONBUILD \\\nRUN --mount=type=bind,target=/a\\\n --network=host id\n'],
	['an escape directive other than backslash', '# escape=`\nFROM alpine\nRUN echo a`\nFROM evil:1\n'],
	['escape directive, backtick line ends', '# escape=`\nFROM alpine\nADD --chown=0`\n git@github.com:org/priv.git /x\n'],
]

// Dockerfiles that are fine: the base images and image reads must be exactly BuildKit's.
export const CONT_MUST_READ: Array<[string, string, string[], string[]]> = [
	['comment and blank lines inside a continuation', 'FROM alpine\nRUN echo a \\\n  # c \\\n\n  && echo b\nFROM node:22\n', ['alpine', 'node:22'], ['alpine', 'node:22']],
	['a comment line ending in a backslash inside a continuation', 'FROM alpine\nCOPY --chown=0 \\\n# c\\\n  --from=other:1 /a /b\n', ['alpine'], ['alpine', 'other:1']],
	['a backslash alone on a line continues: the FROM after it is RUN text', 'FROM alpine\nRUN echo a \\\n\\\nFROM evil:1\n', ['alpine'], ['alpine']],
	['an indented backslash with trailing blanks alone on a line', 'FROM alpine\nRUN echo a \\\n  \\ \t\nFROM evil:1\n', ['alpine'], ['alpine']],
	['a flag continued as its own word', 'FROM alpine\nCOPY --chown=0 \\\n\t--from=other:1 /a /b\nFROM node:22\n', ['alpine', 'node:22'], ['alpine', 'other:1', 'node:22']],
	['trailing blanks after a continuation', 'FROM alpine\nRUN echo a \\  \t\n  b\nFROM node:22\n', ['alpine', 'node:22'], ['alpine', 'node:22']],
	['CRLF continuation', 'FROM alpine\r\nRUN a \\\r\n  b\r\nFROM node:22\r\n', ['alpine', 'node:22'], ['alpine', 'node:22']],
	['a heredoc after a continuation, a body line ending in a backslash', 'FROM alpine\nCOPY \\\n  <<EOF /x\nhello \\\nEOF\nFROM node:22\n', ['alpine', 'node:22'], ['alpine', 'node:22']],
	['a heredoc RUN after a continuation', 'FROM alpine\nRUN \\\n  <<EOF sh\necho a\nEOF\nFROM node:22 AS b\n', ['alpine', 'node:22'], ['alpine', 'node:22']],
	['ONBUILD with flags continued as their own words', 'FROM alpine\nONBUILD COPY --chown=0 \\\n  --from=other:1 /a /b\nFROM node:22\n', ['alpine', 'node:22'], ['alpine', 'other:1', 'node:22']],
	['COPY flag glued, --from= on the next line: the image is read', 'FROM alpine\nCOPY --chown=0\\\n  --from=otherapp:latest /app /stolen\n', ['alpine'], ['alpine', 'otherapp:latest']],
	['COPY flag glued, --from= on a tab-indented line', 'FROM alpine\nCOPY --chown=0\\\n\t--from=otherapp:latest /app /stolen\n', ['alpine'], ['alpine', 'otherapp:latest']],
	['COPY flag glued, --from= with no indent joins into the flag (no image read)', 'FROM alpine\nCOPY --chown=0\\\n--from=otherapp:latest /app /stolen\n', ['alpine'], ['alpine']],
	['a --from= value split over a line break', 'FROM alpine\nCOPY --from=other\\\napp:1 /a /b\n', ['alpine'], ['alpine', 'otherapp:1']],
	['FROM flag glued: the image on the next line is the base', 'FROM --platform=$BUILDPLATFORM\\\n evil:1 AS b\nFROM alpine\n', ['evil:1', 'alpine'], ['evil:1', 'alpine']],
	['ONBUILD COPY flag glued', 'FROM alpine\nONBUILD COPY --chown=0\\\n --from=otherapp:latest /a /b\n', ['alpine'], ['alpine', 'otherapp:latest']],
	['an explicit backslash escape directive', '# escape=\\\nFROM alpine\nRUN a \\\n  b\nFROM node:22\n', ['alpine', 'node:22'], ['alpine', 'node:22']],
]

// a body after the marker that holds a FROM: if the awk missed the heredoc it would read
// that FROM as a stage (and insert its ARG into the body).
export const HEREDOC_BODY = '\nFROM evil:1\nEOF\nRUN true\n'

export const HEREDOC_MUST_REFUSE: Array<[string, string]> = [
	// blanks after << (BuildKit keeps them in the marker word: << EOF is <<EOF)
	['<< EOF (a space after <<)', `FROM alpine\nRUN cat << EOF${HEREDOC_BODY}`],
	['<<<tab>EOF', `FROM alpine\nRUN cat <<\tEOF${HEREDOC_BODY}`],
	['<<- EOF', `FROM alpine\nRUN cat <<- EOF${HEREDOC_BODY}`],
	['<< "EOF"', `FROM alpine\nRUN cat << "EOF"${HEREDOC_BODY}`],
	['<< at the end of the line', 'FROM alpine\nRUN cat <<\nRUN true\n'],
	['ONBUILD RUN << EOF', `FROM alpine\nONBUILD RUN cat << EOF${HEREDOC_BODY}`],
	['COPY << EOF', `FROM alpine\nCOPY << EOF /x${HEREDOC_BODY}`],
	['ADD << EOF', `FROM alpine\nADD << EOF /x${HEREDOC_BODY}`],
	// << inside a larger word
	['cat<<EOF', `FROM alpine\nRUN cat<<EOF${HEREDOC_BODY}`],
	['<<EOF glued to a redirect', `FROM alpine\nRUN cat <<EOF>out${HEREDOC_BODY}`],
	['<<EOF) inside $(...)', `FROM alpine\nRUN x=$(cat <<EOF)${HEREDOC_BODY}`],
	['two markers glued', `FROM alpine\nRUN cat <<EOF<<B${HEREDOC_BODY}`],
	['an escaped <', `FROM alpine\nRUN cat \\<<EOF${HEREDOC_BODY}`],
	['an escaped blank before the marker (one shell word)', 'FROM alpine\nRUN echo a\\ <<EOF\nRUN true\nEOF\nFROM node:22\n'],
	['a bit shift', 'FROM alpine\nRUN echo $((1<<3))\n'],
	// << inside quotes or ${...}
	['<<EOF inside double quotes', 'FROM alpine\nRUN echo "a <<EOF b"\nRUN true\nEOF\nFROM node:22\n'],
	['<<EOF inside single quotes', "FROM alpine\nRUN echo 'a <<EOF b'\nRUN true\nEOF\nFROM node:22\n"],
	['an unbalanced quote after the marker (BuildKit drops every word)', "FROM alpine\nRUN cat <<EOF '\nRUN true\nEOF\nFROM node:22\n"],
	['a bad ${} substitution after the marker', 'FROM alpine\nRUN cat <<EOF ${}\nRUN true\nEOF\nFROM node:22\n'],
	['a ${X:-...} default holding the marker', `FROM alpine\nRUN cat \${X:-<<EOF}${HEREDOC_BODY}`],
	['a ${X:- ...} default with the marker as its own word', `FROM alpine\nRUN cat \${X:- <<EOF }${HEREDOC_BODY}`],
	['a quoted marker with a blank', `FROM alpine\nRUN cat <<"E OF"\nE OF\nFROM evil:1\nRUN true\n`],
	// here-strings and other << forms
	['a here-string <<<', 'FROM alpine\nRUN cat <<< "hi"\n'],
	['a here-string glued <<<EOF', `FROM alpine\nRUN cat <<<EOF${HEREDOC_BODY}`],
	// names outside the allow-list
	['a dotted name', 'FROM alpine\nRUN cat <<EOF.sh\nx\nEOF.sh\n'],
	['a name with a dash', 'FROM alpine\nRUN cat <<--EOF\nx\n-EOF\n'],
	['a name starting with a digit', 'FROM alpine\nRUN cat <<1EOF\nx\n1EOF\n'],
	['a name with a variable', 'FROM alpine\nRUN cat <<$X\nx\n$X\n'],
	['a half-quoted name', 'FROM alpine\nRUN cat <<"EOF\nx\nEOF\n'],
	['mixed quotes', 'FROM alpine\nRUN cat <<"EOF\'\nx\nEOF\n'],
	// non-ASCII on a line with <<
	['a no-break space before the marker', `FROM alpine\nRUN cat <<EOF${HEREDOC_BODY}`],
	['an ideographic space after the marker', `FROM alpine\nRUN cat <<EOF　x${HEREDOC_BODY}`],
	['an em space between << and the name', `FROM alpine\nRUN cat << EOF${HEREDOC_BODY}`],
	['U+0085 before the marker', `FROM alpine\nRUN cat\u0085<<EOF${HEREDOC_BODY}`],
	['non-ASCII text on the marker line', `FROM alpine\nRUN echo é <<EOF${HEREDOC_BODY}`],
	// Unicode whitespace in any instruction line outside heredoc bodies
	['a no-break space between COPY sources', 'FROM alpine\nCOPY a b /x\n'],
	['an em space in a RUN command', 'FROM alpine\nRUN echo hi\n'],
	['a narrow no-break space in an ENV', 'FROM alpine\nENV A=b c\n'],
	['a line separator in a LABEL', 'FROM alpine\nLABEL a=b c\n'],
	['an ideographic space in a continued RUN', 'FROM alpine\nRUN echo a \\\n  b　c\n'],
	// body end detection: only an exact line ends a body (leading tabs only for <<-)
	['a space-indented terminator with <<- (tabs only)', 'FROM alpine\nRUN cat <<-EOF\n  EOF\nFROM evil:1\nEOF\n'],
	['a tab-indented terminator without -', 'FROM alpine\nRUN cat <<EOF\n\tEOF\nFROM evil:1\nEOF\n'],
	['a terminator with a trailing space', 'FROM alpine\nRUN cat <<EOF\nEOF \nFROM evil:1\nEOF\n'],
	['a terminator in another case', 'FROM alpine\nRUN cat <<EOF\neof\nFROM evil:1\nEOF\n'],
	['two markers end in order (the second name inside the first body)', 'FROM alpine\nRUN cat <<A - <<B\nB\nFROM evil:1\nA\nB\n'],
	['a quoted marker ends at the bare name only', 'FROM alpine\nRUN cat <<"EOF"\n"EOF"\nFROM evil:1\nEOF\n'],
]

// heredocs that work: the stages must be exactly BuildKit's.
export const HEREDOC_MUST_READ: Array<[string, string, string[]]> = [
	['<<EOF', 'FROM alpine\nRUN <<EOF\necho a\nEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['<<EOF with a command after it', 'FROM alpine\nRUN <<EOF sh -e\necho a\nEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['<<-EOF with tab-indented body and terminator', 'FROM alpine\nRUN <<-EOF\n\techo a\n\t\tEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['<<"EOF"', 'FROM alpine\nRUN <<"EOF"\necho $HOME\nEOF\nFROM node:22\n', ['alpine', 'node:22']],
	["<<'EOF'", "FROM alpine\nRUN <<'EOF'\necho $HOME\nEOF\nFROM node:22\n", ['alpine', 'node:22']],
	['<<-"EOF"', 'FROM alpine\nRUN <<-"EOF"\n\techo a\n\tEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['a file descriptor', 'FROM alpine\nRUN 3<<EOF cat /dev/fd/3\na\nEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['an underscore name', 'FROM alpine\nRUN <<_MY_SCRIPT_2\necho a\n_MY_SCRIPT_2\nFROM node:22\n', ['alpine', 'node:22']],
	['COPY with two heredocs, ended in order', 'FROM alpine\nCOPY <<A <<B /dst/\nfile a\nA\nfile b\nB\nFROM node:22\n', ['alpine', 'node:22']],
	['RUN with two heredocs, the first name inside the second body', 'FROM alpine\nRUN cat <<A - <<B\na\nA\nA\nb\nB\nFROM node:22\n', ['alpine', 'node:22']],
	['ADD heredoc', 'FROM alpine\nADD <<EOT /etc/motd\nhello\nEOT\nFROM node:22\n', ['alpine', 'node:22']],
	['ONBUILD RUN heredoc', 'FROM alpine\nONBUILD RUN <<EOF\necho a\nEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['flags before the marker', 'FROM alpine\nRUN --mount=type=bind,target=/a <<EOF\necho a\nEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['a plain ${VAR} on the marker line', 'FROM alpine\nCOPY <<EOF ${HOME}/x\na\nEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['quoted words around the marker', 'FROM alpine\nRUN <<EOF sh -c "echo a b" \'x y\'\necho a\nEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['a body line that looks like a heredoc instruction', 'FROM alpine\nRUN <<OUTER\nRUN cat <<INNER\nOUTER\nFROM node:22\n', ['alpine', 'node:22']],
	['a body line with an odd << form', 'FROM alpine\nRUN <<EOF\nRUN cat << x\necho $((1<<2))\nEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['a space-indented name inside a body does not end it', 'FROM alpine\nRUN <<EOF\n  EOF\nEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['CRLF heredoc', 'FROM alpine\r\nRUN <<EOF\r\necho a\r\nEOF\r\nFROM node:22\r\n', ['alpine', 'node:22']],
	['Unicode spaces and text inside a body', 'FROM alpine\nRUN <<EOF\necho a b　c voilà\nEOF\nFROM node:22\n', ['alpine', 'node:22']],
	['non-ASCII text in a RUN without <<', 'FROM alpine\nRUN echo "voilà ça marche"\nFROM node:22\n', ['alpine', 'node:22']],
	['Unicode spaces inside quotes (one shell word to BuildKit too)', 'FROM alpine\nRUN echo "voilà !" \'a　b\'\nLABEL note="x y"\nFROM node:22\n', ['alpine', 'node:22']],
	['a redirect and a single <', 'FROM alpine\nRUN echo a >>log && cat < log\nFROM node:22\n', ['alpine', 'node:22']],
	['<< in an instruction that takes no heredoc', 'FROM alpine\nLABEL note="a << b"\nFROM node:22\n', ['alpine', 'node:22']],
]

export const FROMREF_MUST_REFUSE: Array<[string, string]> = [
	['FROM ${TARGETSTAGE:-b} names a later stage', 'FROM alpine AS b\nFROM ${TARGETSTAGE:-b} AS mid\nRUN true\nFROM alpine AS otherapp-web\nCOPY --from=mid /x /x\n'],
	['FROM ${BUILDOS:+x}${BUILDOS:-b}', 'FROM alpine AS b\nFROM ${BUILDOS:+x}${BUILDOS:-b}\nRUN true\n'],
	['FROM $TARGETARCH with a meta ARG', 'ARG TARGETARCH\nFROM alpine AS b\nFROM ${TARGETARCH:-b}\n'],
	['a meta ARG default that uses TARGETSTAGE', 'ARG X=${TARGETSTAGE:-b}\nFROM alpine AS b\nFROM $X AS mid\nFROM alpine AS otherapp-web\n'],
	['--mount from= with TARGETOS', 'FROM alpine AS b\nFROM alpine\nARG TARGETOS\nRUN --mount=from=${TARGETOS:-b},target=/m true\n'],
	['COPY --from= an index past the last stage', 'FROM alpine AS b\nFROM alpine\nCOPY --from=5 /x /x\n'],
	['FROM ${TARGETOSVERSION:-b}', 'FROM alpine AS b\nFROM ${TARGETOSVERSION:-b}\nRUN true\n'],
	['a value for BUILDOSVERSION', 'ARG BUILDOSVERSION=10.0.17763.1\nFROM alpine\n'],
]
