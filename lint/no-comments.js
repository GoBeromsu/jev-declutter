const DIRECTIVE = /(oxlint|eslint)-(disable|enable)/;

const noComments = {
  create(context) {
    return {
      Program(node) {
        for (const comment of context.sourceCode.getAllComments()) {
          context.report({ message: "Comments are not allowed.", loc: comment.loc });
          if (DIRECTIVE.test(comment.value)) {
            context.report({ message: "Lint directives are not allowed.", node });
          }
        }
      },
    };
  },
};

export default {
  meta: { name: "no-comments" },
  rules: { "no-comments": noComments },
};
