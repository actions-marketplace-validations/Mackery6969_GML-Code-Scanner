# Organization workflow template

Put GML Code Scanner on the **Actions → New workflow** ("Choose a workflow") page of every
repository in your GitHub organization, with a **Configure** button that opens the
pre-built workflow.

1. In your organization, create a repository named `.github` (or use the existing one).
   It can be private: templates in a private `.github` repository are offered to the
   organization's private repositories, as long as members can read it.
2. Copy the three files from [`workflow-templates/`](workflow-templates) into a
   `workflow-templates/` folder at the root of that repository.
3. In any repository of the organization, open **Actions → New workflow**. GML Code Scanner
   appears in a section named after your organization (and is suggested for repositories
   with a `.yyp` at the root).

The workflow works for public and private repositories alike. Where code scanning isn't
available, the results are shown as pull request annotations and in the job summary instead.
