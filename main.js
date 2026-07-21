const axios = require('axios');
const fs = require('fs');
const core = require('@actions/core');

async function validateSubscription() {
  let repoPrivate;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && fs.existsSync(eventPath)) {
    const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    repoPrivate = payload?.repository?.private;
  }

  const upstream = 'wyrihaximus/github-action-helm3';
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl = 'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions';
  core.info('');
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m');
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m');
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info('');
  if (repoPrivate === false) return;
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const body = { action: action || '' };
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body, { timeout: 3000 }
    );
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      core.error(`\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`);
      core.error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`);
      process.exit(1);
    }
    core.info('Timeout or API not reachable. Continuing to next step.');
  }
}

async function main() {
    await validateSubscription();
    const {randomUUID} = require('crypto');
    const homedir = require('os').homedir();
    const tempdir = require('os').tmpdir();
    const {execFile} = require('child_process');
    const tmp = require('tmp');
    const {waitFile} = require('wait-file');

    const multiLineDelimiter = randomUUID();

    console.log("\033[36mPWD: " + process.cwd() + "\033[0m");

    tmp.setGracefulCleanup();

    const execShFile = tmp.fileSync({
        mode: 0o744,
        prefix: 'helm-exec-',
        postfix: '.sh',
        discardDescriptor: true,
    });
    const dockerKubeConfigDir = tempdir + '/docker-kube-config-' + Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 13);
    fs.mkdirSync(dockerKubeConfigDir, {
        mode: 0o777,
    });
    const dockerKubeConfig = dockerKubeConfigDir + '/config';
    const helmCacheDir = tempdir + '/helm-cache-' + Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 13);
    fs.mkdirSync(helmCacheDir, {
        mode: 0o744,
    });

    const kubeConfigLocation = homedir + '/.kube/config';
    const kubeConfigLocationTempOld = kubeConfigLocation + '_tmp_f' + Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 13) + 'f';
    const kubeConfigExists = fs.existsSync(kubeConfigLocation);
    if (kubeConfigExists && process.env.INPUT_OVERRULE_EXISTING_KUBECONFIG === "true") {
        console.log("\033[36mExisting kubeconfig found, but provided kubeconfig is overruling it\033[0m");
        console.log("\033[36mWill be swapping out existing kubeconfig for the duration of the execution of this action\033[0m");
        fs.renameSync(kubeConfigLocation, kubeConfigLocationTempOld);
        fs.appendFileSync(
            kubeConfigLocation,
            "\r\n\r\n" + process.env.INPUT_KUBECONFIG + "\r\n\r\n",
            {
                mode: 0o600,
            }
        );
    } else if (kubeConfigExists) {
        console.log("\033[36mExisting kubeconfig found, using that and ignoring input\033[0m");
    } else {
        console.log("\033[36mUsing kubeconfig from input\033[0m");
        fs.mkdirSync(homedir + '/.kube', {
            recursive: true,
        });
        fs.appendFileSync(
            kubeConfigLocation,
            "\r\n\r\n" + process.env.INPUT_KUBECONFIG + "\r\n\r\n",
            {
                mode: 0o600,
            }
        );
    }

    fs.writeFileSync(
        dockerKubeConfig,
        fs.readFileSync(kubeConfigLocation),
        {
            mode: 0o600,
        }
    );
    console.log("\033[36mPreparing helm execution\033[0m");
    fs.appendFileSync(
        execShFile.name,
        '#!/bin/bash\n' +
        ' \n' +
        'kubectl () {\n' +
        '    ' + dockerKubeConfigDir + '/kubectl "$@"\n' +
        '}\n' +
        'helm () {\n' +
        '    ' + dockerKubeConfigDir + '/helm "$@"\n' +
        '}\n' +
        ' \n' +
        'curl -s -o ' + dockerKubeConfigDir + ' "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl" 2>&1\n' +
        'curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/master/scripts/get-helm-3 > /dev/null 2>&1\n' +
        'chmod 700 get_helm.sh > /dev/null 2>&1\n' +
        'DESIRED_VERSION="' + (process.env.INPUT_HELM_VERSION || '') + '" HELM_INSTALL_DIR=' + dockerKubeConfigDir + ' ./get_helm.sh > /dev/null 2>&1\n' +
        'rm ./get_helm.sh > /dev/null 2>&1\n' +
        ' \n' +
        process.env.INPUT_EXEC
    );

    await waitFile({
        resources: [
            kubeConfigLocation,
            execShFile.name,
        ],
    });

    try {
        console.log("\033[36mExecuting helm\033[0m");
        const result = await new Promise((resolve, reject) => {
            const process = execFile(execShFile.name);
            process.stdout.on('data', console.log);
            process.stderr.on('data', console.log);
            let result = '';
            process.stdout.on('data', (data) => result += data);
            process.stderr.on('data', (data) => result += data);
            process.on('exit', (code) => {
                if (code === 0) {
                    resolve(result);
                } else {
                    reject(result);
                }
            });
        });
        const [output, notes] = result.split(/^NOTES:$/m);
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `helm_output<<${multiLineDelimiter}\n${output}\n${multiLineDelimiter}\n`
        );
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `helm_notes<<${multiLineDelimiter}\n${notes}\n${multiLineDelimiter}\n`
        );

    } catch (error) {
        process.exit(1);
    } finally {
        console.log("\033[36mCleaning up: \033[0m");
        fs.unlinkSync(execShFile.name);
        fs.unlinkSync(dockerKubeConfig);
        console.log("\033[36m  - exec ✅ \033[0m");
        if (
            !kubeConfigExists ||
            (
                kubeConfigExists && process.env.INPUT_OVERRULE_EXISTING_KUBECONFIG === "true"
            )
        ) {
            fs.unlinkSync(kubeConfigLocation);
            console.log("\033[36m  - kubeconfig ✅ \033[0m");
        }
        if (kubeConfigExists && process.env.INPUT_OVERRULE_EXISTING_KUBECONFIG === "true") {
            fs.renameSync(kubeConfigLocationTempOld, kubeConfigLocation);
            console.log("\033[36m  - kubeconfig restored ✅ \033[0m");
        }
    }
}

main();
