'use strict';

const _ = require('lodash');
const crypto = require('crypto');
const { addCustomResourceToService } = require('../../../../customResources');

class AwsCompileEventBridgeEvents {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.provider = this.serverless.getProvider('aws');

    this.hooks = {
      'package:compileEvents': this.compileEventBridgeEvents.bind(this),
    };

    // TODO: Complete schema, see https://github.com/serverless/serverless/issues/8029
    this.serverless.configSchemaHandler.defineFunctionEvent('aws', 'eventBridge', {
      type: 'object',
    });
  }

  compileEventBridgeEvents() {
    const { service } = this.serverless;
    const { provider } = service;
    const { compiledCloudFormationTemplate } = provider;
    const iamRoleStatements = [];
    let hasEventBusesIamRoleStatement = false;
    let anyFuncUsesEventBridge = false;

    service.getAllFunctions().forEach(functionName => {
      const functionObj = service.getFunction(functionName);
      const FunctionName = functionObj.name;

      if (functionObj.events) {
        functionObj.events.forEach((event, idx) => {
          if (event.eventBridge) {
            if (typeof event.eventBridge === 'object') {
              idx++;
              anyFuncUsesEventBridge = true;

              const EventBus = event.eventBridge.eventBus;
              const Schedule = event.eventBridge.schedule;
              const Pattern = event.eventBridge.pattern;
              const Input = event.eventBridge.input;
              const InputPath = event.eventBridge.inputPath;
              let InputTransformer = event.eventBridge.inputTransformer;
              const RuleNameSuffix = `rule-${idx}`;
              let RuleName = `${FunctionName}-${RuleNameSuffix}`;
              if (RuleName.length > 64) {
                // Rule names cannot be longer than 64.
                // Temporary solution until we have https://github.com/serverless/serverless/issues/6598
                RuleName = `${RuleName.slice(0, 31 - RuleNameSuffix.length)}${crypto
                  .createHash('md5')
                  .update(RuleName)
                  .digest('hex')}-${RuleNameSuffix}`;
              }

              const eventFunctionLogicalId = this.provider.naming.getLambdaLogicalId(functionName);
              const customResourceFunctionLogicalId = this.provider.naming.getCustomResourceEventBridgeHandlerFunctionLogicalId();
              const customEventBridgeResourceLogicalId = this.provider.naming.getCustomResourceEventBridgeResourceLogicalId(
                functionName,
                idx
              );

              if (!Pattern && !Schedule) {
                const errorMessage = [
                  'You need to configure the pattern or schedule property (or both) ',
                  'for eventBridge events.',
                ].join('');
                throw new this.serverless.classes.Error(errorMessage);
              }

              const inputOptions = [Input, InputPath, InputTransformer].filter(i => i);
              if (inputOptions.length > 1) {
                const errorMessage = [
                  'You can only set one of input, inputPath, or inputTransformer ',
                  'properties for eventBridge events.',
                ].join('');
                throw new this.serverless.classes.Error(errorMessage);
              }

              if (InputTransformer) {
                const config = Object.assign({}, InputTransformer);
                InputTransformer = {};
                if (!config.inputTemplate) {
                  throw new this.serverless.classes.Error(
                    'The inputTemplate key is required when specifying an ' +
                      'inputTransformer for an eventBridge event'
                  );
                }
                InputTransformer.InputTemplate = config.inputTemplate;
                if (config.inputPathsMap) {
                  InputTransformer.InputPathsMap = config.inputPathsMap;
                }
              }

              const customEventBridge = {
                [customEventBridgeResourceLogicalId]: {
                  Type: 'Custom::EventBridge',
                  Version: 1.0,
                  DependsOn: [eventFunctionLogicalId, customResourceFunctionLogicalId],
                  Properties: {
                    ServiceToken: {
                      'Fn::GetAtt': [customResourceFunctionLogicalId, 'Arn'],
                    },
                    FunctionName,
                    EventBridgeConfig: {
                      RuleName,
                      EventBus,
                      Schedule,
                      Pattern,
                      Input,
                      InputPath,
                      InputTransformer,
                    },
                  },
                },
              };

              _.merge(compiledCloudFormationTemplate.Resources, customEventBridge);

              if (EventBus) {
                let eventBusName = EventBus;
                if (EventBus.startsWith('arn')) {
                  eventBusName = EventBus.slice(EventBus.indexOf('/') + 1);
                }

                if (!hasEventBusesIamRoleStatement && eventBusName !== 'default') {
                  const eventBusResources = {
                    'Fn::Join': [
                      ':',
                      [
                        'arn',
                        { Ref: 'AWS::Partition' },
                        'events',
                        { Ref: 'AWS::Region' },
                        { Ref: 'AWS::AccountId' },
                        'event-bus/*',
                      ],
                    ],
                  };
                  iamRoleStatements.push({
                    Effect: 'Allow',
                    Resource: eventBusResources,
                    Action: ['events:CreateEventBus', 'events:DeleteEventBus'],
                  });
                  hasEventBusesIamRoleStatement = true;
                }
              }
            } else {
              const errorMessage = [
                `Event Bridge event of function "${functionName}" is not an object`,
                ' Please check the docs for more info.',
              ].join('');
              throw new this.serverless.classes.Error(errorMessage);
            }
          }
        });
      }
    });

    if (anyFuncUsesEventBridge) {
      const ruleResources = {
        'Fn::Join': [
          ':',
          [
            'arn',
            { Ref: 'AWS::Partition' },
            'events',
            { Ref: 'AWS::Region' },
            { Ref: 'AWS::AccountId' },
            'rule/*',
          ],
        ],
      };
      iamRoleStatements.push({
        Effect: 'Allow',
        Resource: ruleResources,
        Action: [
          'events:PutRule',
          'events:RemoveTargets',
          'events:PutTargets',
          'events:DeleteRule',
        ],
      });
      const functionResources = {
        'Fn::Join': [
          ':',
          [
            'arn',
            { Ref: 'AWS::Partition' },
            'lambda',
            { Ref: 'AWS::Region' },
            { Ref: 'AWS::AccountId' },
            'function',
            '*',
          ],
        ],
      };
      iamRoleStatements.push({
        Effect: 'Allow',
        Resource: functionResources,
        Action: ['lambda:AddPermission', 'lambda:RemovePermission'],
      });
    }

    if (iamRoleStatements.length) {
      return addCustomResourceToService(this.provider, 'eventBridge', iamRoleStatements);
    }

    return null;
  }
}

module.exports = AwsCompileEventBridgeEvents;
