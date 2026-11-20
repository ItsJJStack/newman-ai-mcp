/**
 * @fileoverview Deterministic CI/CD and Docker templates (cicdTemplates.ts).
 * Supports GitHub Actions, GitLab CI, Azure DevOps, Jenkins, and Dockerfile (Tool 8).
 */

export type CicdOptions = {
  platform: 'github-actions' | 'gitlab-ci' | 'azure-devops' | 'jenkins' | 'dockerfile';
  collectionSource: string;
  environmentPath?: string;
  iterationDataPath?: string;
  useHtmlExtra?: boolean;
  nodeVersion?: string;
};

export type CicdResult = {
  suggestedPath: string;
  content: string;
  requiredSecrets: string[];
};

/**
 * Generates CI/CD configuration for the selected platform.
 */
export function generateCicdPipelineConfig(options: CicdOptions): CicdResult {
  const {
    platform,
    collectionSource,
    environmentPath,
    iterationDataPath,
    useHtmlExtra = false,
    nodeVersion = '20',
  } = options;

  const isUid = /^\d+-[0-9a-fA-F-]{36}$/.test(collectionSource) || collectionSource.includes('api.getpostman.com');
  const requiredSecrets: string[] = [];

  if (isUid || collectionSource.includes('api.getpostman.com')) {
    requiredSecrets.push('POSTMAN_API_KEY');
  }

  if (isUid && parseInt(nodeVersion, 10) < 18) {
    throw new Error('Downloading a collection by UID in CI/CD requires Node >= 18 (nodeVersion >= 18).');
  }

  let downloadStep = '';
  let runCollectionTarget = collectionSource;

  if (isUid) {
    runCollectionTarget = 'collection.json';
    downloadStep = `  - name: Download Postman Collection
    run: node -e 'fetch("https://api.getpostman.com/collections/${collectionSource}", { headers: { "X-Api-Key": process.env.POSTMAN_API_KEY } }).then(r => r.json()).then(d => require("fs").writeFileSync("collection.json", JSON.stringify(d.collection)))'
`;
  }

  const reporters = ['junit', 'json'];
  if (useHtmlExtra) reporters.push('htmlextra');
  const reportersStr = reporters.join(',');

  const reporterArgs = [
    `--reporters ${reportersStr}`,
    `--reporter-junit-export newman/results.xml`,
    `--reporter-json-export newman/results.json`,
    useHtmlExtra ? `--reporter-htmlextra-export newman/report.html` : '',
  ].filter(Boolean).join(' ');

  const envArg = environmentPath ? `-e ${environmentPath}` : '';
  const dataArg = iterationDataPath ? `-d ${iterationDataPath}` : '';
  const runCommand = `npx newman run ${runCollectionTarget} ${envArg} ${dataArg} ${reporterArgs}`.replace(/\s+/g, ' ').trim();

  let suggestedPath = '';
  let content = '';

  switch (platform) {
    case 'github-actions':
      suggestedPath = '.github/workflows/newman.yml';
      content = `name: Newman API Tests

on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Use Node.js \${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: '${nodeVersion}'

      - name: Install Newman & Reporters
        run: npm install -g newman@6.2.3 ${useHtmlExtra ? 'newman-reporter-htmlextra@1.23' : ''}

${downloadStep}      - name: Run Newman Tests
        id: newman
        continue-on-error: true
        env:
          POSTMAN_API_KEY: \${{ secrets.POSTMAN_API_KEY }}
        run: |
          mkdir -p newman
          ${runCommand}

      - name: Publish Test Report
        uses: dorny/test-reporter@v1
        if: always()
        with:
          name: Newman Tests
          path: newman/results.xml
          reporter: jest-junit

      - name: Upload Report Artifacts
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: newman-reports
          path: newman/

      - name: Check Newman Status
        if: steps.newman.outcome != 'success'
        run: exit 1
`;
      break;

    case 'gitlab-ci':
      suggestedPath = '.gitlab-ci.yml';
      content = `stages:
  - test

newman_test:
  stage: test
  image: node:${nodeVersion}-alpine
  script:
    - mkdir -p newman
    - npm install -g newman@6.2.3 ${useHtmlExtra ? 'newman-reporter-htmlextra@1.23' : ''}
    ${isUid ? `- node -e 'fetch("https://api.getpostman.com/collections/${collectionSource}", { headers: { "X-Api-Key": process.env.POSTMAN_API_KEY } }).then(r => r.json()).then(d => require("fs").writeFileSync("collection.json", JSON.stringify(d.collection)))'` : ''}
    - ${runCommand}
  artifacts:
    when: always
    reports:
      junit: newman/results.xml
    paths:
      - newman/
  rules:
    - if: '$CI_PIPELINE_SOURCE == "push" || $CI_PIPELINE_SOURCE == "merge_request_event"'
`;
      break;

    case 'azure-devops':
      suggestedPath = 'azure-pipelines.yml';
      content = `trigger:
  - main

pool:
  vmImage: 'ubuntu-latest'

steps:
- task: NodeTool@0
  inputs:
    versionSpec: '${nodeVersion}.x'
  displayName: 'Install Node.js'

- script: |
    npm install -g newman@6.2.3 ${useHtmlExtra ? 'newman-reporter-htmlextra@1.23' : ''}
    mkdir -p newman
    ${isUid ? `node -e 'fetch("https://api.getpostman.com/collections/${collectionSource}", { headers: { "X-Api-Key": process.env.POSTMAN_API_KEY } }).then(r => r.json()).then(d => require("fs").writeFileSync("collection.json", JSON.stringify(d.collection)))'` : ''}
    ${runCommand}
  displayName: 'Run Newman Tests'
  env:
    POSTMAN_API_KEY: $(POSTMAN_API_KEY)
  condition: always()

- task: PublishTestResults@2
  inputs:
    testResultsFormat: 'JUnit'
    testResultsFiles: 'newman/results.xml'
    mergeTestResults: true
  condition: always()
  displayName: 'Publish Test Results'
`;
      break;

    case 'jenkins':
      suggestedPath = 'Jenkinsfile';
      content = `pipeline {
    agent any
    environment {
        POSTMAN_API_KEY = credentials('POSTMAN_API_KEY')
    }
    stages {
        stage('Test') {
            steps {
                sh '''
                    npm install -g newman@6.2.3 ${useHtmlExtra ? 'newman-reporter-htmlextra@1.23' : ''}
                    mkdir -p newman
                    ${isUid ? `node -e 'fetch("https://api.getpostman.com/collections/${collectionSource}", { headers: { "X-Api-Key": process.env.POSTMAN_API_KEY } }).then(r => r.json()).then(d => require("fs").writeFileSync("collection.json", JSON.stringify(d.collection)))'` : ''}
                    ${runCommand}
                '''
            }
            post {
                always {
                    junit 'newman/results.xml'
                    archiveArtifacts artifacts: 'newman/**'
                }
            }
        }
    }
}
`;
      break;

    case 'dockerfile':
      suggestedPath = 'Dockerfile';
      content = `FROM node:${nodeVersion}-alpine
WORKDIR /app
RUN npm install -g newman@6.2.3 ${useHtmlExtra ? 'newman-reporter-htmlextra@1.23' : ''}
COPY . /app
RUN mkdir -p newman
CMD ${isUid ? `node -e 'fetch("https://api.getpostman.com/collections/${collectionSource}", { headers: { "X-Api-Key": process.env.POSTMAN_API_KEY } }).then(r => r.json()).then(d => require("fs").writeFileSync("collection.json", JSON.stringify(d.collection)))' && ` : ''}${runCommand}
`;
      break;
  }

  return {
    suggestedPath,
    content,
    requiredSecrets,
  };
}
