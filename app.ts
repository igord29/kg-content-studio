import { createApp } from '@agentuity/runtime';

const { server, logger } = await createApp({
	hostname: '0.0.0.0',
	port: parseInt(process.env.PORT || '8080', 10),
	setup: async () => {
		// anything you return from this will be automatically
		// available in the ctx.app. this allows you to initialize
		// global resources and make them available to routes and
		// agents in a typesafe way
	},
	shutdown: async (_state) => {
		// the state variable will be the same value was what you
		// return from setup above. you can use this callback to
		// close any resources or other shutdown related tasks
	},
});

logger.debug('Running %s', server.url);
