'use babel'

// eslint-disable-next-line import/extensions, import/no-extraneous-dependencies
import { CompositeDisposable, File } from 'atom'
import getRuleMarkDown from './rule-helpers'

const DEFAULT_ARGS = [
  '--cache', 'false',
  '--force-exclusion',
  '--format', 'json',
  '--display-style-guide',
]

let helpers
let path
let pluralize
let semver

const loadDeps = () => {
  if (!helpers) {
    helpers = require('atom-linter')
  }
  if (!path) {
    path = require('path')
  }
  if (!pluralize) {
    pluralize = require('pluralize')
  }
  if (!semver) {
    semver = require('semver')
  }
}

const parseFromStd = (stdout, stderr) => {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    // continue regardless of error
  }
  if (typeof parsed !== 'object') { throw new Error(stderr || stdout) }
  return parsed
}

const getProjectDirectory = filePath => (
  atom.project.relativizePath(filePath)[0] || path.dirname(filePath))

const getRubocopBaseCommand = (commands, passedPath) => {
  const commandAndProjectPath = commands.find(capp => path.relative(capp[1], passedPath))
  return commandAndProjectPath[0].split(/\s+/).filter(i => i).concat(DEFAULT_ARGS)
}

const forwardRubocopToLinter = (version, {
  message: rawMessage, location, severity, cop_name: copName,
}, file, editor) => {
  const hasCopName = semver.gte(version, '0.52.0')
  const [excerpt, url] = rawMessage.split(/ \((.*)\)/, 2)
  let position
  if (location) {
    const { line, column, length } = location
    position = [[line - 1, column - 1], [line - 1, (length + column) - 1]]
  } else {
    position = helpers.generateRange(editor, 0)
  }

  const severityMapping = {
    refactor: 'info',
    convention: 'info',
    warning: 'warning',
    error: 'error',
    fatal: 'error',
  }

  const linterMessage = {
    url,
    excerpt: hasCopName ? excerpt : `${copName}: ${excerpt}`,
    severity: severityMapping[severity],
    location: {
      file,
      position,
    },
  }

  getRuleMarkDown(url).then((markdown) => {
    if (markdown) {
      linterMessage.description = markdown
    }
  })

  return linterMessage
}
const getValueFromFile = async (fullPath, prefix = '') => {
  const file = new File(fullPath)
  const fileValue = await file.read()
  if (fileValue) {
    const toReturn = fileValue.split('\n')[0]
    if (toReturn) { // So prefix isnt added to empty string
      return `${prefix}${toReturn}`
    }
  }
  return ''
}

const getWorkspaceCommands = async (command, useRVMForVersionAndGemsetFile) => {
  loadDeps()
  const toReturnPromise = atom.project.getPaths().map(async (projectPath) => {
    if (command === 'rubocop' && useRVMForVersionAndGemsetFile) {
      const rubyVersion = await getValueFromFile(path.join(projectPath, '.ruby-version'))
      const rubyGemset = await getValueFromFile(path.join(projectPath, '.ruby-gemset'), '@')
      if (rubyVersion || rubyGemset) {
        const rubyVersionGemset = `${rubyVersion || 'default'}${rubyGemset}`
        return [`rvm ${rubyVersionGemset} do ${command}`, projectPath]
      }
    }
    return [command, projectPath]
  })
  return Promise.all(toReturnPromise)
}

export default {
  activate() {
    this.idleCallbacks = new Set()
    let depsCallbackID
    const installLinterRubocopDeps = () => {
      this.idleCallbacks.delete(depsCallbackID)
      if (!atom.inSpecMode()) {
        require('atom-package-deps').install('linter-rubocop', true)
      }
      loadDeps()
    }
    depsCallbackID = window.requestIdleCallback(installLinterRubocopDeps)
    this.idleCallbacks.add(depsCallbackID)

    this.subscriptions = new CompositeDisposable()

    // Register fix command
    this.subscriptions.add(
      atom.commands.add('atom-text-editor', {
        'linter-rubocop:fix-file': async () => {
          const textEditor = atom.workspace.getActiveTextEditor()

          if (!atom.workspace.isTextEditor(textEditor) || textEditor.isModified()) {
            // Abort for invalid or unsaved text editors
            return atom.notifications.addError('Linter-Rubocop: Please save before fixing')
          }

          const filePath = textEditor.getPath()
          if (!filePath) { return null }

          const cwd = getProjectDirectory(filePath)
          const command = getRubocopBaseCommand(this.commands, filePath).concat('--auto-correct')
          command.push(filePath)

          const { stdout, stderr } = await helpers.exec(command[0], command.slice(1), { cwd, stream: 'both', env: this.env })
          const { summary: { offense_count: offenseCount } } = parseFromStd(stdout, stderr)
          return offenseCount === 0
            ? atom.notifications.addInfo('Linter-Rubocop: No fixes were made')
            : atom.notifications.addSuccess(`Linter-Rubocop: Fixed ${pluralize('offenses', offenseCount, true)}`)
        },
      }),
      atom.config.observe('linter-rubocop.command', async (value) => {
        const useRVMForVersionAndGemsetFile = atom.config.get('linter-rubocop.useRVMForVersionAndGemsetFile')
        this.env = this.checkForRVMFile ? { rvm_silence_path_mismatch_check_flag: '1' } : {}
        this.commands = await getWorkspaceCommands(value, useRVMForVersionAndGemsetFile)
      }),
      atom.config.onDidChange('linter-rubocop.useRVMForVersionAndGemsetFile', async (value) => {
        const command = atom.config.get('linter-rubocop.command')
        const useRVMForVersionAndGemsetFile = value.newValue
        this.env = useRVMForVersionAndGemsetFile ? { rvm_silence_path_mismatch_check_flag: '1' } : {}
        this.commands = await getWorkspaceCommands(command, useRVMForVersionAndGemsetFile)
      }),
      atom.config.observe('linter-rubocop.disableWhenNoConfigFile', (value) => {
        this.disableWhenNoConfigFile = value
      }),
      atom.config.observe('linter-rubocop.runExtraRailsCops', (value) => {
        this.runExtraRailsCops = value
      }),
    )
  },

  deactivate() {
    this.idleCallbacks.forEach(callbackID => window.cancelIdleCallback(callbackID))
    this.idleCallbacks.clear()
    this.subscriptions.dispose()
  },

  provideLinter() {
    return {
      name: 'RuboCop',
      grammarScopes: [
        'source.ruby',
        'source.ruby.gemfile',
        'source.ruby.rails',
        'source.ruby.rspec',
        'source.ruby.chef',
      ],
      scope: 'file',
      lintsOnChange: true,
      lint: async (editor) => {
        const filePath = editor.getPath()
        if (!filePath) { return null }

        loadDeps()

        if (this.disableWhenNoConfigFile === true) {
          const config = await helpers.findAsync(filePath, '.rubocop.yml')
          if (config === null) {
            return []
          }
        }

        const cwd = getProjectDirectory(filePath)
        const command = getRubocopBaseCommand(this.commands, filePath)
        command.push('--stdin', filePath)
        const stdin = editor.getText()
        const exexOptions = {
          cwd,
          stdin,
          stream: 'both',
          timeout: 10000,
          uniqueKey: `linter-rubocop::${filePath}`,
          env: this.env,
        }

        let output
        try {
          output = await helpers.exec(command[0], command.slice(1), exexOptions)
        } catch (e) {
          if (e.message !== 'Process execution timed out') throw e
          atom.notifications.addInfo(
            'Linter-Rubocop: Linter timed out',
            {
              description: 'Make sure you are not running Rubocop with a slow-starting interpreter like JRuby. '
                           + 'If you are still seeing timeouts, consider running your linter `on save` and not `on change`, '
                           + 'or reference https://github.com/AtomLinter/linter-rubocop/issues/202 .',
            },
          )
          return null
        }
        // Process was canceled by newer process
        if (output === null) { return null }

        const {
          metadata: { rubocop_version: rubocopVersion }, files,
        } = parseFromStd(output.stdout, output.stderr)

        if (rubocopVersion == null || rubocopVersion === '') {
          throw new Error('Unable to get rubocop version from linting output results.')
        }

        const offenses = files && files[0] && files[0].offenses
        return (offenses || []).map(
          offense => forwardRubocopToLinter(rubocopVersion, offense, filePath, editor),
        )
      },
    }
  },
}
